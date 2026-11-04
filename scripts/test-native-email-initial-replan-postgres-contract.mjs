#!/usr/bin/env node
// Actual DAL + pure contracts + real RSA; deliberately synthetic SQL rows.
// retained_evidence_valid and the SQL helper's response are fixture ports,
// NOT actual SQL, native cancellation, installer or activation proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'

assert.equal(process.versions.node.split('.')[0], '24', 'Use the supported bundled Node24 runtime')
assert.equal(process.argv.length, 2, 'No database, runtime or mutation arguments are supported')
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const cache = new Map(), unexpected = () => {throw new Error('Unused future-policy/native dependency was called')}
function load(name) {
  if (cache.has(name)) return cache.get(name)
  const module = {exports: {}}
  const source = readFileSync(new URL(`../app_src/lib/crm/${name}.ts`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  }}).outputText
  new Function('require', 'module', 'exports', code)(specifier => {
    if (specifier === 'server-only') return {}
    if (specifier === 'node:crypto') return crypto
    if (specifier === './nativeEmailEligibility') return {nativeEmailEffectivePipelinePrincipals: unexpected}
    if (specifier === './nativeEmailRootReaders') return {
      collectNativeEmailRootSourcesWithClient: unexpected, projectNativeEmailRootReaders: unexpected,
    }
    if (specifier === './suiteCrmNativeEmailProjection') return {suiteCrmEmailAudienceFingerprint: unexpected}
    assert.ok(specifier.startsWith('./'), `Unexpected dependency: ${specifier}`)
    return load(specifier.slice(2))
  }, module, module.exports)
  cache.set(name, module.exports)
  return module.exports
}
const base = load('nativeEmailPublication'), lineageApi = load('nativeEmailInitialInstallationLineage')
const enrollmentApi = load('nativeEmailInitialEnrollment')
const {PostgresNativeEmailInitialEnrollmentStore: Store} = load('nativeEmailInitialEnrollmentPostgres')
const {NativeEmailPublicationHeld: Held, nativeEmailCanonicalJson: canonical, nativeEmailDigest: digest} = base
const copy = value => JSON.parse(JSON.stringify(value)), hash = value => crypto.createHash('sha256').update(value).digest('hex')
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const A = hash('original-operation-A'), B = hash('successor-operation-B'), C = hash('successor-operation-C')
const independentRootPin = hash('independently-supplied-original-source')
const selection = {actorEmail: 'new-owner@example.invalid', operatorAccountId: uuid(1), rootWorkspaceId: uuid(2), nativeInstanceId: 'fixture-native'}
const key = crypto.generateKeyPairSync('rsa', {modulusLength: 3072})
const verification = {publicKey: key.publicKey, keyId: 'fixture-initial-key', serviceUserId: 'native-service', oauthClientId: uuid(3)}
const sign = proof => crypto.sign('sha256', Buffer.from(canonical(proof), 'ascii'), {
  key: key.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING,
}).toString('base64')
function refreshApproval(row, mutate = () => {}) {
  mutate(row.approval_envelope.proof)
  row.approval_envelope.signature = sign(row.approval_envelope.proof)
  row.approval_canonical = canonical(row.approval_envelope); row.approval_hash = digest(row.approval_envelope)
  row.native_receipt.approvalHash = row.approval_hash
  row.receipt_canonical = canonical(row.native_receipt); row.receipt_hash = digest(row.native_receipt)
}
function historyEntry(operation, lineage = null) {
  const principals = ['admin', 'reader'], capabilities = readers => Object.fromEntries(
    ['view', 'list', 'export', 'edit', 'delete'].map(surface => [surface, [...readers]]))
  const pipelineId = uuid(4), workspaceId = uuid(5), readers = ['admin']
  const audience = {policy: 'pipeline-internal', ownerSuiteCrmId: 'admin', allowedSuiteCrmUserIds: readers, workspaceId, pipelineId}
  const policy = {version: 2, pipelineId, workspaceId, ownerSuiteCrmId: 'admin',
    audienceFingerprint: hash(JSON.stringify(audience)), principalSuiteCrmUserIds: principals, futureCreate: capabilities(readers), historical: []}
  const before = {localId: uuid(6), nativeId: uuid(7), globalId: 'gi1000000', pipelineId, workspaceId,
    archived: false, recordFingerprint: digest(['old content', operation]), capabilities: capabilities(principals)}
  const after = {...copy(before), capabilities: capabilities(readers)}
  const defaults = ['delete', 'edit', 'export', 'list', 'view'].map((action, i) => ({
    before: {id: uuid(10 + i), action, aclAccess: 90}, after: {id: uuid(10 + i), action, aclAccess: ['delete', 'edit'].includes(action) ? 75 : 80},
  }))
  const runtime = lineage?.freshInstalledRuntimeFingerprint ?? hash('original-stock-runtime')
  const source = digest(['old app snapshot', operation])
  const plan = {version: 1, kind: lineage ? 'initial_enrollment_replan_v1' : 'initial_enrollment_plan_v1', operationId: operation,
    nativeInstanceId: selection.nativeInstanceId, appGeneration: 3, appSourceFingerprint: source,
    nativePolicyBeforeFingerprint: hash('old before policy'), nativeRuntimeBeforeFingerprint: runtime,
    nativePolicyAfterFingerprint: hash('old after policy'), nativeRuntimeAfterFingerprint: hash('after runtime'),
    principalSuiteCrmUserIds: principals, defaults, emails: [{before, after}], pipelines: [{groupId: uuid(8), policy}],
    reviewedRevocations: ['delete', 'edit', 'export', 'list', 'view'].map(surface => ({nativeId: before.nativeId, surface, principalId: 'reader'})),
    rootEmployeeGrants: [], ...(lineage ? {installationLineage: lineage} : {})}
  const evidence = {complete: {appEmails: true, nativeEmails: true, nativePrincipals: true, pipelineAuthority: true, nativeDefaults: true},
    nativeInstanceId: plan.nativeInstanceId, appGeneration: plan.appGeneration, appSourceFingerprint: source,
    nativePolicyFingerprint: plan.nativePolicyBeforeFingerprint, nativeRuntimeFingerprint: runtime,
    principalSuiteCrmUserIds: principals, emails: [copy(before)], defaults: defaults.map(row => copy(row.before)),
    approvedPipelines: copy(plan.pipelines), reviewedRevocations: copy(plan.reviewedRevocations)}
  enrollmentApi.prepareNativeEmailInitialEnrollment(plan, evidence)
  const preparedAt = '2026-11-03 12:00:00', installed = lineage?.freshInstalledRuntimeFingerprint ?? hash('original-installed-runtime')
  const journal = lineage ? lineageApi.effectiveNativeEmailInitialInstallationJournalFingerprint(lineage, operation) : hash('immutable-root-journal')
  const nativeDelta = {version: 1, purpose: 'clawpilot-native-email-initial-policy-delta', operationId: operation, planHash: digest(plan), preparedAt,
    changes: {acl_actions: [], securitygroups: [], securitygroups_users: [], securitygroups_records: []},
    result: {generation: 3, appSourceFingerprint: source, beforePolicyFingerprint: plan.nativePolicyBeforeFingerprint,
      afterPolicyFingerprint: plan.nativePolicyAfterFingerprint, sourceRuntimeFingerprint: runtime, installedRuntimeFingerprint: installed,
      runtimeFingerprint: plan.nativeRuntimeAfterFingerprint, identityFingerprint: hash('identities'), capabilitiesFingerprint: hash('caps'),
      bindingsFingerprint: hash('bindings'), defaultsFingerprint: hash('defaults'), emailCount: 1, principalCount: 2}, policies: []}
  const proof = {version: 1, purpose: 'clawpilot-native-email-initial-enrollment-approval', issuer: 'clawpilot-pg-initial-enrollment',
    audience: 'clawpilot-suitecrm-initial-enrollment', keyId: verification.keyId, nativeInstanceId: selection.nativeInstanceId,
    serviceUserId: verification.serviceUserId, oauthClientId: verification.oauthClientId, issuedAt: 1793707200, expiresAt: 1793707320,
    operationId: operation, planHash: digest(plan), appGeneration: 3, appSourceFingerprint: source, preparedAt,
    deltaFingerprint: digest(nativeDelta), sourceRuntimeFingerprint: runtime, installedRuntimeFingerprint: installed, installationJournalFingerprint: journal}
  const row = {operation_id: operation, actor_email: 'old-owner@example.invalid', operator_account_id: selection.operatorAccountId,
    root_workspace_id: selection.rootWorkspaceId, native_instance_id: selection.nativeInstanceId, generation: '3', source_fingerprint: source,
    state: 'cancelled', plan_hash: digest(plan), delta_fingerprint: digest(nativeDelta), approval_envelope: {proof, signature: ''},
    approval_canonical: '', approval_hash: '', native_receipt: {version: 1, purpose: 'clawpilot-native-email-initial-enrollment-receipt',
      operationId: operation, planHash: digest(plan), approvalHash: '', state: 'cancelled', result: null}, receipt_canonical: '', receipt_hash: '',
    plan_kind: plan.kind, plan_operation_id: operation, plan_native_instance_id: plan.nativeInstanceId, plan_generation: '3',
    plan_source_fingerprint: source, plan_runtime_before: runtime, installation_lineage: lineage, retained_evidence_valid: true}
  refreshApproval(row)
  return row
}
// Independent fixed-ASCII history preimage, not the implementation's digest helper.
function historyFingerprint(rows) {
  return hash('[' + [...rows].sort((a, b) => a.operation_id < b.operation_id ? -1 : 1).map(row =>
    `{"approvalHash":"${row.approval_hash}","cancellationReceiptHash":"${row.receipt_hash}","deltaFingerprint":"${row.delta_fingerprint}","operationId":"${row.operation_id}","planHash":"${row.plan_hash}"}`).join(',') + ']')
}
function expectedContext(rows, predecessor, pin) {
  const root = rows.find(row => row.plan_kind === 'initial_enrollment_plan_v1'), prior = rows.find(row => row.operation_id === predecessor)
  assert.ok(root && prior, 'This fixture oracle requires a selected root and predecessor')
  return {version: 1, purpose: 'clawpilot-native-email-initial-replan-context', rootOperationId: root.operation_id,
    rootInstallationJournalFingerprint: root.approval_envelope.proof.installationJournalFingerprint, rootSourceArtifactDigest: pin,
    rootStockRuntimeFingerprint: root.approval_envelope.proof.sourceRuntimeFingerprint, predecessorOperationId: prior.operation_id,
    predecessorPlanHash: prior.plan_hash, predecessorApprovalHash: prior.approval_hash, predecessorCancellationReceiptHash: prior.receipt_hash,
    previousLineageHash: prior.installation_lineage ? digest(prior.installation_lineage) : null,
    depth: rows.length, cancelledHistoryFingerprint: historyFingerprint(rows)}
}
function successor(rows, operation, predecessor) {
  const lineage = lineageApi.finalizeNativeEmailInitialInstallationLineage(expectedContext(rows, predecessor, independentRootPin),
    operation, digest(['fresh source', operation]), hash('fresh installed runtime'))
  return historyEntry(operation, lineage)
}
function fixture(rows = [historyEntry(A)], operation = B, predecessor = A) {
  const sourceFingerprint = hash('current independent SQL source'), queries = []
  const state = {rows: copy(rows), operation, predecessor, sourceFingerprint, sourcePresent: true, authorized: true,
    control: {singleton: true, enabled: false, generation: 9, active_initial_enrollment_id: operation, active_operation_id: null, active_transition_id: null},
    reservation: {operation_id: operation, actor_email: selection.actorEmail, operator_account_id: selection.operatorAccountId,
      root_workspace_id: selection.rootWorkspaceId, native_instance_id: selection.nativeInstanceId, generation: 9, state: 'reserved', source_fingerprint: sourceFingerprint},
    missing: [], sqlContext: null, controlMissing: false, reservationMissing: false}
  const query = async (sql, values = []) => {
    const text = sql.replace(/\s+/g, ' ').trim(); queries.push({text, values})
    assert.match(text, /^SELECT /, 'The context reader must not issue any write')
    if (text.startsWith('SELECT * FROM crm_native_email_publication_control')) return {rows: state.controlMissing ? [] : [state.control]}
    if (text.startsWith('SELECT a.id FROM crm_operator_accounts')) {
      assert.deepEqual(values, [selection.operatorAccountId, selection.rootWorkspaceId, selection.actorEmail])
      return {rows: state.authorized ? [{id: selection.operatorAccountId}] : []}
    }
    if (text.startsWith('SELECT * FROM crm_native_email_initial_reservations')) {
      assert.deepEqual(values, [operation]); return {rows: state.reservationMissing ? [] : [state.reservation]}
    }
    if (text.startsWith('SELECT snapshot,encode(digest(snapshot::text')) return {rows: state.sourcePresent ? [{snapshot: {version: 1, currentOnly: true}, fingerprint: state.sourceFingerprint}] : []}
    if (text.startsWith('SELECT e.operation_id,e.actor_email')) {
      assert.deepEqual(values, [selection.nativeInstanceId, operation]); assert.match(text, /ORDER BY e\.operation_id COLLATE "C" LIMIT 501 FOR SHARE OF e,r/)
      assert.ok(!text.includes('SELECT e.*'), 'History must stay a bounded summary')
      return {rows: state.rows.map(row => {
        const summary = {...row}
        for (const field of ['plan', 'native_delta', 'source_snapshot']) Object.defineProperty(summary, field, {
          get() {throw new Error('Ancestor old content/capability matrix must not be loaded')},
        })
        return summary
      })}
    }
    if (text.startsWith('SELECT r.operation_id FROM crm_native_email_initial_reservations')) return {rows: state.missing}
    if (text.startsWith('SELECT clawpilot_crm_native_initial_replan_context(')) {
      assert.equal(values[0], operation); assert.equal(values[1], state.predecessor)
      return {rows: state.sqlContext ?? [{context: expectedContext(state.rows, values[1], values[2])}]}
    }
    throw new Error(`Unexpected SQL outside the synthetic reader contract: ${text}`)
  }
  const store = new Store(async run => run({query}), selection, undefined, verification)
  return {state, queries, store, read: (pin = independentRootPin, prior = state.predecessor) => store.readReplanContext(operation, prior, pin)}
}
let checks = 0
async function check(label, run) {await run(); checks++; console.log(`PASS ${label}`)}
const rejects = async (f, pattern = /initial_pg_|initial_installation_lineage_|invalid_json_/) => assert.rejects(f.read(), error => error instanceof Held && pattern.test(error.code))

await check('first successor derives exact root/receipt anchors with actual RSA and historical login change', async () => {
  const f = fixture(), expected = expectedContext(f.state.rows, A, independentRootPin), context = await f.read()
  assert.deepEqual(context, expected); assert.equal(Object.isFrozen(context), true)
  assert.notEqual(f.state.rows[0].actor_email, selection.actorEmail)
  assert.equal(context.previousLineageHash, null); assert.equal(context.depth, 1)
  assert.equal(Object.hasOwn(context, 'freshSourceArtifactDigest'), false)
  assert.match(f.queries[0].text, /^SELECT \* FROM crm_native_email_publication_control/)
  assert.match(f.queries[1].text, /^SELECT a.id FROM crm_operator_accounts/)
  assert.equal(f.queries.at(-1).text, 'SELECT clawpilot_crm_native_initial_replan_context($1,$2,$3) AS context')
})
await check('repeated chain uses complete sorted five-field history, previous lineage and effective journal', async () => {
  const root = historyEntry(A), prior = successor([root], B, A), f = fixture([prior, root], C, B)
  const context = await f.read()
  assert.deepEqual(context, expectedContext([root, prior], B, independentRootPin)); assert.equal(context.depth, 2)
  assert.equal(context.previousLineageHash, digest(prior.installation_lineage))
  assert.equal(context.cancelledHistoryFingerprint, historyFingerprint([prior, root]))
  const reversed = fixture([root, prior], C, B)
  assert.deepEqual(await reversed.read(), context)
})
await check('first independent root-source pin is copied but not claimed installer-verified; repeated pins are immutable', async () => {
  const alternatePin = hash('different independently supplied pin'), first = fixture()
  assert.equal((await first.read(alternatePin)).rootSourceArtifactDigest, alternatePin)
  const root = historyEntry(A), prior = successor([root], B, A), repeated = fixture([root, prior], C, B)
  await assert.rejects(repeated.read(alternatePin), error => error instanceof Held && error.code === 'initial_pg_replan_historical_lineage_changed')
})
await check('control-first current owner, reservation selection and source fences fail closed', async () => {
  for (const mutate of [f => {f.state.controlMissing = true}, f => {f.state.authorized = false}, f => {f.state.reservationMissing = true},
    f => {f.state.control.enabled = true}, f => {f.state.control.active_initial_enrollment_id = hash('other')},
    f => {f.state.control.active_operation_id = hash('ordinary')}, f => {f.state.control.active_transition_id = hash('transition')},
    f => {f.state.reservation.state = 'cancelled'}, f => {f.state.reservation.generation = 8},
    f => {f.state.reservation.actor_email = 'old-owner@example.invalid'}, f => {f.state.reservation.operator_account_id = uuid(90)},
    f => {f.state.reservation.root_workspace_id = uuid(91)}, f => {f.state.reservation.native_instance_id = 'foreign-native'},
    f => {f.state.sourceFingerprint = hash('changed source')}, f => {f.state.sourcePresent = false}]) {
    const f = fixture(); mutate(f); await rejects(f)
    assert.equal(f.queries.some(query => query.text.startsWith('SELECT e.operation_id')), false)
  }
})
await check('absent, uncertain, committed, invalid SQL evidence, unresolved reservation and foreign history are refused', async () => {
  for (const mutate of [f => {f.state.rows = []}, f => {f.state.rows[0].state = 'unknown'}, f => {f.state.rows[0].state = 'dispatched'},
    f => {f.state.rows[0].state = 'activated'}, f => {f.state.rows[0].retained_evidence_valid = false},
    f => {f.state.rows[0].retained_evidence_valid = 'true'}, f => {f.state.missing = [{operation_id: hash('unfinished')}]},
    f => {f.state.rows[0].operator_account_id = uuid(80)}, f => {f.state.rows[0].root_workspace_id = uuid(81)},
    f => {f.state.rows[0].native_instance_id = 'foreign-native'}, f => {f.state.rows[0].plan_kind = 'unknown-kind'}]) {
    const f = fixture(); mutate(f); await rejects(f)
  }
})
await check('canonical approval/receipt bytes and real RSA tampering cannot be replaced by a fixture validity boolean', async () => {
  for (const mutate of [row => {row.approval_canonical += '\n'}, row => {row.approval_hash = hash('forged approval hash')},
    row => {row.receipt_canonical += '\n'}, row => {row.receipt_hash = hash('forged receipt hash')},
    row => {row.receipt_hash += '\n'}, row => {row.native_receipt.state = 'committed'}, row => {row.native_receipt.result = {}},
    row => {row.native_receipt.operationId = hash('other')}, row => {row.native_receipt.extra = true},
    row => {row.approval_envelope.signature = 'A'.repeat(512); row.approval_canonical = canonical(row.approval_envelope); row.approval_hash = digest(row.approval_envelope)}]) {
    const f = fixture(); mutate(f.state.rows[0]); await rejects(f)
  }
  const f = fixture(), bad = f.state.rows[0]
  refreshApproval(bad, proof => {proof.audience = 'another-audience'})
  await rejects(f, /initial_pg_approval_domain/)
  for (const field of ['operation_id', 'plan_hash', 'delta_fingerprint', 'approval_hash', 'receipt_hash']) {
    for (const value of ['invalid', `${'a'.repeat(64)}\n`, hash('different-valid-hash')]) {
      const changed = fixture(); changed.state.rows[0][field] = value; await rejects(changed)
    }
  }
})
await check('signed historical destination, plan, runtime, generation and expiry bounds remain exact', async () => {
  for (const mutate of [p => {p.planHash = hash('other-plan')}, p => {p.operationId = hash('other-operation')},
    p => {p.deltaFingerprint = hash('other-delta')}, p => {p.nativeInstanceId = 'other-native'},
    p => {p.keyId = 'other-key'}, p => {p.serviceUserId = 'other-service'}, p => {p.oauthClientId = uuid(99)},
    p => {p.appGeneration = 4}, p => {p.appSourceFingerprint = hash('other-source')},
    p => {p.sourceRuntimeFingerprint = hash('other-before-runtime')}, p => {p.issuedAt = 0},
    p => {p.expiresAt = p.issuedAt}, p => {p.expiresAt = p.issuedAt + 301}]) {
    const f = fixture(); refreshApproval(f.state.rows[0], mutate); await rejects(f)
  }
  for (const field of ['plan_operation_id', 'plan_native_instance_id', 'plan_generation', 'plan_source_fingerprint', 'plan_runtime_before']) {
    const f = fixture(); f.state.rows[0][field] = field === 'plan_generation' ? '4' : hash('changed summary')
    await rejects(f)
  }
})
await check('missing predecessor/root, branches, cycles, root-lineage and depth bounds are refused', async () => {
  const root = historyEntry(A), prior = successor([root], B, A)
  await assert.rejects(fixture().read(independentRootPin, hash('missing-predecessor')), error => error instanceof Held)
  await rejects(fixture([prior], C, B))
  await rejects(fixture([root, historyEntry(hash('second-original-root'))]))
  const rootLineage = fixture(); rootLineage.state.rows[0].installation_lineage = prior.installation_lineage; await rejects(rootLineage)
  const tooMany = fixture(); tooMany.state.rows = Array.from({length: 501}, () => copy(root)); await rejects(tooMany, /replan_history_bound/)
  const wrongDepth = fixture([root, prior], C, B); wrongDepth.state.rows[1].installation_lineage.depth = 2; await rejects(wrongDepth)
  const x = hash('cycle-X'), y = hash('cycle-Y'), cyclic = fixture([root, prior], C, B)
  const cycleContext = {...expectedContext([root, prior], B, independentRootPin), depth: 2, predecessorOperationId: y, previousLineageHash: hash('cycle-prior')}
  const xLineage = lineageApi.finalizeNativeEmailInitialInstallationLineage(cycleContext, x, hash('x-source'), hash('fresh installed runtime'))
  const yLineage = lineageApi.finalizeNativeEmailInitialInstallationLineage({...cycleContext, predecessorOperationId: x}, y, hash('y-source'), hash('fresh installed runtime'))
  cyclic.state.rows = [root, historyEntry(x, xLineage), historyEntry(y, yLineage)]; cyclic.state.predecessor = x
  await assert.rejects(cyclic.store.readReplanContext(C, x, independentRootPin), error => error instanceof Held && /chain_missing_or_cycle/.test(error.code))
})
await check('historical replan anchors, installed runtime and effective journal cannot drift', async () => {
  const root = historyEntry(A), prior = successor([root], B, A)
  for (const mutate of [row => {row.installation_lineage.previousLineageHash = hash('unexpected previous')},
    row => {row.installation_lineage.rootInstallationJournalFingerprint = hash('other journal')},
    row => {row.installation_lineage.rootStockRuntimeFingerprint = hash('other stock')},
    row => {row.installation_lineage.cancelledHistoryFingerprint = hash('missing history')},
    row => {row.installation_lineage.predecessorCancellationReceiptHash = hash('other cancellation')},
    row => {row.installation_lineage.predecessorApprovalHash = hash('other approval')},
    row => {row.installation_lineage.freshInstalledRuntimeFingerprint = hash('other installed runtime')},
    row => {refreshApproval(row, proof => {proof.installedRuntimeFingerprint = hash('wrong installed')})},
    row => {refreshApproval(row, proof => {proof.installationJournalFingerprint = hash('wrong effective journal')})}]) {
    const f = fixture([root, prior], C, B); mutate(f.state.rows[1]); await rejects(f)
  }
})
await check('SQL reconstruction cardinality and value mismatch remain held without trusting its opaque response', async () => {
  for (const response of [[], [{context: {...expectedContext([historyEntry(A)], A, independentRootPin), depth: 2}}],
    [{context: expectedContext([historyEntry(A)], A, independentRootPin)}, {context: null}]]) {
    const f = fixture(); f.state.sqlContext = response; await rejects(f, /replan_sql_context_changed/)
  }
})
await check('inputs are strict hashes and no old body/capability matrix or native I/O is loaded', async () => {
  const f = fixture()
  for (const [operation, predecessor, pin] of [['bad', A, independentRootPin], [B, `${A}\n`, independentRootPin], [B, A, null]]) {
    await assert.rejects(f.store.readReplanContext(operation, predecessor, pin), error => error instanceof Held && error.code === 'initial_pg_hash')
  }
  assert.equal(f.queries.length, 0)
  await f.read()
  assert.ok(f.queries.every(query => !/Email|capabilities|record_fingerprint/.test(query.text)))
})
await check('forward migration preserves 0398 bytes and the entire original admission body outside intended additions', async () => {
  const original = readFileSync(new URL('../db/migrations/0398_crm_native_email_initial_enrollment.sql', import.meta.url), 'utf8')
  const forward = readFileSync(new URL('../db/migrations/0399_crm_native_email_initial_replan_lineage.sql', import.meta.url), 'utf8')
  assert.equal(hash(original), '00ba0afd16e90ef321199e0c497b0f75029b3efc3d6af7edee0673e0bc20afd7')
  const oldBody = original.match(/CREATE FUNCTION clawpilot_crm_native_initial_admit\(\)[\s\S]*?END \$\$;/)?.[0]
  let newBody = forward.match(/CREATE OR REPLACE FUNCTION clawpilot_crm_native_initial_admit\(\)[\s\S]*?END \$\$;/)?.[0]
  assert.ok(oldBody && newBody)
  newBody = newBody.replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION')
    .replace('reservation public.crm_native_email_initial_reservations;lineage jsonb;expected_context jsonb;lineage_hash text;effective_journal text;',
      'reservation public.crm_native_email_initial_reservations;')
    .replace("'rootEmployeeGrants']\n     || CASE WHEN p->>'kind'='initial_enrollment_replan_v1' THEN ARRAY['installationLineage'] ELSE ARRAY[]::text[] END)", "'rootEmployeeGrants'])")
    .replace("p->>'kind' IN ('initial_enrollment_plan_v1','initial_enrollment_replan_v1')", "p->>'kind'='initial_enrollment_plan_v1'")
    .replace(/ IF p->>'kind'='initial_enrollment_replan_v1' THEN[\s\S]*? END IF;\n(?= IF \(proof->>'issuedAt'\))/, '')
  assert.equal(newBody, oldBody, 'Any unrelated original admission change requires separate review')
  assert.ok(!/CREATE TABLE|ADD COLUMN|set_config|current_setting/i.test(forward))
  assert.match(forward, /REVOKE ALL ON FUNCTION clawpilot_crm_native_initial_lineage_digest\(jsonb\),\s*clawpilot_crm_native_initial_replan_context\(text,text,text\) FROM PUBLIC/)
})
await check('demo quarantine preserves historical migrations, snapshot and every unrelated enrollment-body byte', async () => {
  const read = name => readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8')
  const initial = read('0398_crm_native_email_initial_enrollment.sql')
  const replan = read('0399_crm_native_email_initial_replan_lineage.sql')
  const quarantine = read('0400_crm_native_email_demo_quarantine.sql')
  assert.equal(hash(initial), '00ba0afd16e90ef321199e0c497b0f75029b3efc3d6af7edee0673e0bc20afd7')
  assert.equal(hash(replan), 'd701ad48ad8629c3ea71d3987c5eeba4a7df33b79b98ff46ca8c220de0b31a34')
  const before = quarantine.match(/old_predicate text:=\$before\$([\s\S]*?)\$before\$/)?.[1]
  const after = quarantine.match(/new_predicate text:=\$after\$([\s\S]*?)\$after\$/)?.[1]
  assert.ok(before && after)
  assert.equal(after.replace(/\n   AND NOT public\.clawpilot_crm_native_initial_demo_quarantine\(o\.id,encode\(public\.digest\(to_jsonb\(o\)::text,'sha256'\),'hex'\)\)/, ''),
    before, 'Only the strict quarantine predicate may be added to the existing writer hold')
  const pins = [...quarantine.matchAll(/\('public\.(clawpilot_crm_native_initial_(?:reserve|admit))\(\)','([a-f0-9]{64})'\)/g)]
  assert.equal(pins.length, 2)
  for (const [, name, pin] of pins) {
    const source = name.endsWith('_reserve') ? initial : replan
    const body = source.match(new RegExp(`FUNCTION ${name}\\(\\)[\\s\\S]*? AS \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1]
    assert.ok(body)
    assert.equal(hash(body), pin, `${name}: the migration must check its exact current preimage`)
    assert.equal(body.split(before).length, 2, `${name}: replace precisely one known predicate`)
    assert.equal(body.replace(before, after).replace(after, before), body)
  }
  assert.match(quarantine, /updated_definition:=replace\(definition,old_predicate,new_predicate\)/)
  assert.match(quarantine, /digest\(replace\(body,new_predicate,old_predicate\),'sha256'\)/)
  assert.doesNotMatch(quarantine, /CREATE (?:OR REPLACE )?FUNCTION clawpilot_crm_native_initial_source_snapshot\(/)
  assert.doesNotMatch(quarantine, /(?:UPDATE|DELETE FROM|INSERT INTO) (?:public\.)?sync_outbox\b/i)
  assert.match(quarantine, /REVOKE ALL ON FUNCTION clawpilot_crm_native_initial_demo_quarantine\(uuid,text\) FROM PUBLIC/)
})
console.log(`PASS ${checks} replan DAL contract groups; real RSA and actual DAL/pure helpers, synthetic SQL evidence/context only; no database/native/installer/activation proof`)
