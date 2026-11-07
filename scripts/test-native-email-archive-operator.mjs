#!/usr/bin/env node
// Real DAL, manifest approvals, custody verification and journal. Only SQL
// and socket exchange are synthetic; there is no live endpoint or transport.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const require = createRequire(new URL('../app_src/package.json', import.meta.url)), ts = require('typescript')
function load(file, dependencies = {}) {
  const source = fs.readFileSync(new URL(`../app_src/${file}.ts`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(dependency => {
    if (Object.hasOwn(dependencies, dependency)) return dependencies[dependency]
    if (dependency === 'server-only') return {}
    assert.ok(dependency.startsWith('node:'), dependency)
    return require(dependency)
  }, module, module.exports)
  return module.exports
}
const protocol = load('lib/crm/nativeEmailPublication')
const shared = { './nativeEmailPublication': protocol,
  './nativeEmailRecoveryStoreBinding': load('lib/crm/nativeEmailRecoveryStoreBinding', { './nativeEmailPublication': protocol }) }
const approval = load('lib/crm/legacyEmailRetirementApproval', shared)
const repairJournal = load('lib/crm/nativeEmailAccountRepairJournal', shared)
const journal = load('lib/crm/nativeEmailArchiveJournal', { ...shared, './nativeEmailAccountRepairJournal': repairJournal })
const custody = load('lib/crm/nativeEmailRecoveryCustodyProof', shared)
const noTransport = () => assert.fail('archive must not start native transport or a publisher')
const transport = load('lib/crm/nativeEmailRecoveryCliTransport', {
  ...shared, './nativeEmailRecoveryDuplexRunner': { createNativeEmailRecoveryDuplexCommandRunner: noTransport },
  './nativeEmailRecoveryReadyProof': { createNativeEmailRecoveryReadyChallenge: noTransport },
})
const dal = load('lib/persistence/crmLegacyEmailRetirement', {
  '../crm/nativeEmailPublication': protocol, '../crm/legacyEmailRetirementApproval': approval,
})
const { nativeEmailCanonicalJson: json, nativeEmailDigest: hash } = protocol
const sha = value => crypto.createHash('sha256').update(value).digest('hex')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const now = () => Math.floor(Date.now() / 1000)
const pem = key => key.export({ format: 'pem', type: 'spki' })
const sign = (proof, key) => ({ proof, signature: crypto.sign('sha256', Buffer.from(json(proof), 'ascii'),
  { key, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64') })
const [absenceKey, operatorKey, custodyKey] = Array.from({ length: 3 }, () => crypto.generateKeyPairSync('rsa', { modulusLength: 3072 }))
const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'clawpilot-archive-operator-'))
after(() => fs.rmSync(root, { recursive: true }))

function fixture({ lostCommit, wrongCustody, wrongDbClock, wrongCount, wrongReceipt, loseAfter, loseBeforeWrite,
  publicationDisposition = 'reviewed_recovery' } = {}) {
  const directory = fs.mkdtempSync(join(root, 'case-')), journalPath = join(directory, 'archive.json')
  const events = [], reads = [], nonces = new Set()
  let openRole = null, attested = false, committed = false
  const native = { projectId: id(1), environmentId: id(2), serviceId: id(3), deploymentId: id(4), deploymentInstanceId: id(5),
    replicaId: id(6), nativeInstanceId: 'native-fixture', database: 'suite_fixture', databasePrincipal: 'fixture_writer@localhost',
    serviceUserId: 'suite-service', oauthClientId: 'suite-oauth', cliSourceHash: hash('cli'), imagePackageHash: hash('image'),
    mariaStoreFingerprint: hash('native db') }
  const ca = '-----BEGIN CERTIFICATE-----\nsynthetic-only\n-----END CERTIFICATE-----'
  const cluster = { host: 'fixture.invalid', port: 5432, database: 'fixture_database', systemIdentifier: '18446744073709551615',
    databaseOid: '4294967295', tlsCaSha256: sha(ca) }
  const appCommit = 'a'.repeat(40), nativeCommit = 'b'.repeat(40), nativeDatabaseFingerprint = hash('native db')
  const postgresDatabaseFingerprint = hash({ version: 1, purpose: 'clawpilot-native-email-archive-postgres-v1', ...cluster })
  const scope = { projectId: native.projectId, environmentId: native.environmentId, postgresDatabaseFingerprint,
    appCommit, nativeDeploymentId: native.deploymentId, nativeReplicaId: native.replicaId, nativeCommit, nativeDatabaseFingerprint }
  const targetFingerprint = hash({ version: 1, purpose: 'clawpilot-native-email-archive-destination-v1', scope,
    native: transport.nativeEmailRecoveryCliTargetFingerprint(native) })
  const operationId = id(7), fenceEpoch = id(8), appGeneration = 4, workspaceId = id(9), pipelineId = id(10)
  const manifest = { version: 1, action: 'archive_exact_legacy_terminal_rows_only', operationId, scope,
    actorEmail: 'owner@work.example.invalid', operatorAccountId: id(11), rootWorkspaceId: workspaceId, appGeneration,
    gateFingerprint: hash('gate'), appSourceFingerprint: hash('source'), fenceEpoch, fenceEvidenceFingerprint: hash('fence'),
    nativeAbsenceFingerprint: hash('absence'), historicalProviderOutcome: 'unknown', publicationDisposition,
    rows: [0, 1, 2].map(i => ({ outboxId: id(20 + i), localId: id(30 + i), nativeId: id(40 + i),
      globalId: 'gi' + (1000000 + i), workspaceId, pipelineId, attempts: 8,
      rowFingerprint: hash(['row', i]), sourceFingerprint: hash(['source', i]), payloadFingerprint: hash(['payload', i]),
      keyFingerprint: hash(['key', i]) })) }
  const manifestDigest = approval.legacyEmailRetirementManifestDigest(manifest), start = now(), expiresAt = start + 105
  const proof = { version: 1, operationId, manifestDigest, audience: 'clawpilot-private-legacy-email-retirement-controller',
    issuedAt: start - 3, expiresAt }
  const fenceEnvelope = sign({ ...proof, keyId: 'absence', purpose: 'clawpilot-legacy-email-fenced-absence-v1',
    issuer: 'clawpilot-crm-fence-attestor' }, absenceKey.privateKey)
  const operatorEnvelope = sign({ ...proof, keyId: 'operator', purpose: 'clawpilot-legacy-email-retirement-review-v1',
    issuer: 'clawpilot-crm-retirement-operator', fenceEnvelopeDigest: hash(fenceEnvelope) }, operatorKey.privateKey)
  const approvalDigest = hash(operatorEnvelope), signed = { manifest, fenceEnvelope, operatorEnvelope }
  const resultPins = { operationId, manifestDigest, approvalDigest }
  const journalPins = { ...resultPins, version: 1, purpose: 'clawpilot-private-native-email-archive-journal-v1', fenceEpoch, targetFingerprint }
  const receipt = { ...resultPins, state: 'committed', rows: manifest.rows.length, historicalProviderOutcome: 'unknown', receiptHash: hash('receipt') }
  const attestorUser = 'archive_attestor', archiveUser = 'archive_controller', inspectUser = 'archive_inspect'
  const socketPath = '/private/tmp/synthetic-archive-custodian.sock', custodianUid = process.geteuid() === 0 ? 1 : 0
  const configFor = action => ({ version: 1, purpose: 'clawpilot-private-native-email-archive', action, native,
    postgres: { ...cluster, user: action === 'archive' ? archiveUser : inspectUser }, appCommit, nativeCommit,
    nativeDatabaseFingerprint, ...resultPins, journal: journalPath, ...(action === 'archive' ? {
      attestorUser, absence: { keyId: 'absence', publicKey: pem(absenceKey.publicKey) },
      operator: { keyId: 'operator', publicKey: pem(operatorKey.publicKey) },
      custody: { keyId: 'custody', publicKey: pem(custodyKey.publicKey), socketPath, uid: custodianUid,
        fenceEpoch, expiresAt: start + 180, producerInventoryHash: hash('producer inventory') },
    } : {}) })
  const readSecrets = { postgresPassword: 'synthetic-controller-password', postgresTlsCa: ca }
  const writeSecrets = { ...readSecrets, attestorPassword: 'synthetic-attestor-password' }
  const expectedSelection = {
    operationId: hash({ version: 1, purpose: 'clawpilot-native-email-archive-custody-operation-v1', operationId }),
    requestFingerprint: hash({ version: 1, purpose: 'clawpilot-native-email-archive-custody-request-v1',
      action: 'archive', manifestDigest, approvalDigest, targetFingerprint }),
  }
  const loadPins = () => JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  const api = load('lib/crm/nativeEmailArchiveOperator', {
    ...shared, './legacyEmailRetirementApproval': approval, './nativeEmailArchiveJournal': journal,
    '../persistence/crmLegacyEmailRetirement': dal, './nativeEmailRecoveryCliTransport': {
      nativeEmailRecoveryCliTargetFingerprint: transport.nativeEmailRecoveryCliTargetFingerprint,
      createNativeEmailRecoveryCliTransport: noTransport,
    },
    './nativeEmailRecoveryCustodyProof': custody, './nativeEmailRecoveryCustodySocket': {
      async requestNativeEmailRecoveryCustody({ socketPath: socket, custodianUid: uid, challenge }) {
        assert.equal(openRole, null)
        assert.equal(socket, socketPath)
        assert.equal(uid, custodianUid)
        assert.equal(challenge.purpose, 'clawpilot-native-email-recovery-custody-challenge-v2')
        for (const [key, value] of Object.entries(expectedSelection)) assert.equal(challenge[key], value)
        assert.equal(challenge.targetFingerprint, targetFingerprint)
        const storeBinding = shared['./nativeEmailRecoveryStoreBinding']
        assert.equal(challenge.storeBindingFingerprint, storeBinding.nativeEmailRecoveryStoreBindingFingerprint({
          targetFingerprint, mariaStoreFingerprint: native.mariaStoreFingerprint,
          postgresStoreFingerprint: storeBinding.nativeEmailPostgresStoreFingerprint({
            database: cluster.database, databaseOid: cluster.databaseOid, systemIdentifier: cluster.systemIdentifier,
          }),
        }))
        assert.equal(challenge.controllerConfigHash, sha(json(configFor('archive')) + '\n'))
        assert.equal(challenge.fenceEpoch, fenceEpoch)
        assert.equal(challenge.producerInventoryHash, hash('producer inventory'))
        assert.match(challenge.nonce, /^[0-9a-f]{64}$/u)
        assert.ok(!nonces.has(challenge.nonce)); nonces.add(challenge.nonce)
        events.push(`custody:${challenge.phase}`)
        if ((loseAfter && challenge.phase === 'after') || (loseBeforeWrite && attested && challenge.phase === 'before')) {
          throw Error('synthetic custody loss')
        }
        return sign({ ...challenge, purpose: 'clawpilot-native-email-recovery-custody-v2', keyId: 'custody', issuedAt: now(),
          retainedClosure: true, postgresObservationHash: hash('postgres observation'), mariaObservationHash: hash('maria observation'),
          ...(wrongCustody ? { storeBindingFingerprint: hash('wrong store') } : {}) }, custodyKey.privateKey)
      },
    },
    './nativeEmailRecoveryPrivatePostgres': {
      createNativeEmailRecoveryPrivatePostgres(options) {
        const { user, ...identity } = options.target
        const { tlsCaSha256: ignored, ...clusterIdentity } = cluster
        void ignored
        assert.deepEqual(identity, clusterIdentity)
        assert.equal(options.tlsCa, ca)
        assert.equal(options.password, user === attestorUser ? writeSecrets.attestorPassword : readSecrets.postgresPassword)
        assert.equal(openRole, null, 'direct logins do not overlap')
        assert.deepEqual(loadPins(), journalPins, 'journal must already exist before either login')
        openRole = user
        events.push(`open:${user}`)
        let transactions = 0, reviewIndex = 0
        const rows = (...values) => ({ rows: values })
        return {
          async transaction(run) {
            assert.equal(++transactions, 1)
            const result = await run({
              async query(sql, args) {
                assert.equal(openRole, user)
                if (sql === "SET LOCAL TIME ZONE 'UTC'") {
                  assert.notEqual(user, inspectUser); return rows()
                }
                if (sql.includes('session_user AS login')) {
                  assert.notEqual(user, inspectUser)
                  return rows({ login: user, role: user, second: wrongDbClock ? start + 1000 : now() })
                }
                if (sql.includes('INSERT INTO crm_legacy_email_retirement.verified_batch')) {
                  assert.equal(user, attestorUser)
                  assert.deepEqual(args, [operationId, appGeneration, fenceEpoch, expiresAt, manifest.rows.length,
                    manifestDigest, hash(fenceEnvelope), approvalDigest, publicationDisposition])
                  events.push('attest:batch')
                  return rows()
                }
                if (sql.includes('INSERT INTO crm_legacy_email_retirement.review')) {
                  assert.equal(user, attestorUser)
                  const row = manifest.rows[reviewIndex++]
                  assert.deepEqual(args, [operationId, row.outboxId, appGeneration, row.rowFingerprint, row.sourceFingerprint,
                    fenceEpoch, expiresAt, row.localId, row.pipelineId, row.workspaceId, row.nativeId, row.globalId,
                    row.payloadFingerprint, row.keyFingerprint])
                  events.push(`attest:row:${row.outboxId}`)
                  return rows()
                }
                if (sql.includes('crm_legacy_email_retirement.retire(')) {
                  assert.equal(user, archiveUser)
                  assert.ok(attested && !committed)
                  assert.deepEqual(args, [operationId, manifest.rows.map(row => row.outboxId), approvalDigest])
                  events.push('archive:exact')
                  return rows({ count: wrongCount ? manifest.rows.length - 1 : manifest.rows.length })
                }
                assert.match(sql, /crm_legacy_email_retirement\.resolve\(/u)
                assert.equal(user, inspectUser)
                assert.deepEqual(args, [operationId, manifestDigest, approvalDigest])
                events.push('inspect:receipt')
                return rows({ receipt: wrongReceipt ? { ...receipt, approvalDigest: hash('wrong receipt') } :
                  committed ? receipt : { state: 'unknown' } })
              },
            })
            if (user === attestorUser) { assert.equal(reviewIndex, manifest.rows.length); attested = true }
            if (user === archiveUser) committed = true
            events.push(`commit:${user}`)
            if (lostCommit === user) throw Error('synthetic COMMIT response lost')
            return result
          },
          async close() { assert.equal(openRole, user); openRole = null; events.push(`close:${user}`) },
        }
      },
    },
  })
  function run(action, tweaks = {}) {
    const config = tweaks.config ?? configFor(action)
    return api.runNativeEmailArchivePrivateOperator({ action, configHash: sha(json(config) + '\n'),
      explicitOperation: Object.hasOwn(tweaks, 'explicitOperation') ? tweaks.explicitOperation : action === 'archive' ? operationId : undefined,
      readConfig: () => config,
      readSecrets: () => tweaks.secrets ?? (action === 'archive' ? writeSecrets : readSecrets),
      readApproval() { assert.equal(action, 'archive'); reads.push('approval'); return tweaks.signed ?? signed },
      readJournal(filename) { assert.equal(filename, journalPath); reads.push('journal'); return tweaks.journal ?? loadPins() },
    })
  }
  return { run, configFor, manifest, signed, journalPath, loadPins, events, reads, writeSecrets, resultPins, journalPins,
    receipt, attestorUser, archiveUser, inspectUser, targetFingerprint, expectedSelection, api }
}

test('retirement uses exact ordered manifest rows, exclusive journal, separate direct logins and no transport', async () => {
  const f = fixture()
  assert.deepEqual(f.api.nativeEmailArchiveCustodySelection({ ...f.resultPins, targetFingerprint: f.targetFingerprint }), f.expectedSelection)
  const result = await f.run('archive')
  assert.deepEqual(result.result, f.resultPins)
  assert.equal(result.successfulObservations, 3)
  assert.match(result.observationsDigest, /^[0-9a-f]{64}$/u)
  assert.deepEqual(f.loadPins(), f.journalPins)
  assert.deepEqual(f.events, ['custody:before', `open:${f.attestorUser}`, 'attest:batch',
    ...f.manifest.rows.map(row => `attest:row:${row.outboxId}`), `commit:${f.attestorUser}`, `close:${f.attestorUser}`,
    'custody:before', `open:${f.archiveUser}`, 'archive:exact', `commit:${f.archiveUser}`, `close:${f.archiveUser}`, 'custody:after'])
})

test('manifest substitution, cross-mode configuration and reused trust or login fail before any SQL or journal', async () => {
  const f = fixture(), cfg = f.configFor('archive')
  await assert.rejects(f.run('archive-inspect', { config: cfg }), /shape/u)
  await assert.rejects(f.run('archive', { explicitOperation: id(99) }), /explicit_operation/u)
  await assert.rejects(f.run('archive', { config: { ...cfg, attestorUser: f.archiveUser } }), /role_separation/u)
  await assert.rejects(f.run('archive-inspect', { secrets: f.writeSecrets }), /shape/u)
  await assert.rejects(f.run('archive', { config: { ...cfg, operator: { keyId: 'different', publicKey: cfg.absence.publicKey } } }), /independent_anchors/u)
  await assert.rejects(f.run('archive', { config: { ...cfg, appCommit: 'c'.repeat(40) } }), /manifest_destination/u)
  await assert.rejects(f.run('archive', { config: { ...cfg, custody: { ...cfg.custody, fenceEpoch: id(99) } } }), /manifest_destination/u)
  await assert.rejects(f.run('archive', { signed: { ...f.signed, manifest: { ...f.manifest, rows: f.manifest.rows.slice(1) } } }), /manifest_digest/u)
  const changedDisposition = { ...f.manifest, publicationDisposition: 'archive_only' }
  const signedWithDrift = { ...f.signed, manifest: changedDisposition }
  await assert.rejects(f.run('archive', { signed: signedWithDrift }), /manifest_digest/u)
  await assert.rejects(f.run('archive', { signed: signedWithDrift,
    config: { ...cfg, manifestDigest: approval.legacyEmailRetirementManifestDigest(changedDisposition) } }), /retirement_proof_binding/u)
  await assert.rejects(f.run('archive', { signed: { ...f.signed,
    operatorEnvelope: { ...f.signed.operatorEnvelope, signature: 'A'.repeat(512) } } }), /retirement_signature/u)
  await assert.rejects(f.run('archive-inspect', { journal: { ...f.journalPins, targetFingerprint: hash('other database') } }), /journal_changed/u)
  assert.deepEqual(f.events, [])
  assert.equal(fs.existsSync(f.journalPath), false)
})

test('archive-only disposition is carried unchanged into the attested database batch', async () => {
  const f = fixture({ publicationDisposition: 'archive_only' })
  const result = await f.run('archive')
  assert.deepEqual(result.result, f.resultPins)
  assert.equal(f.events.filter(event => event === 'attest:batch').length, 1)
  assert.equal(f.events.filter(event => event === 'archive:exact').length, 1)
})

test('custody or database-time drift refuses execution, and an inexact row count cannot commit', async () => {
  const bad = fixture({ wrongCustody: true })
  await assert.rejects(bad.run('archive'), /custody_binding/u)
  assert.deepEqual(bad.events, ['custody:before'])
  assert.equal(fs.existsSync(bad.journalPath), false)
  for (const [condition, expectedError] of [
    ['wrongDbClock', /proof_expiry/u], ['loseBeforeWrite', /synthetic custody loss/u], ['wrongCount', /archive_count_changed/u],
  ]) {
    const f = fixture({ [condition]: true })
    await assert.rejects(f.run('archive'), expectedError)
    assert.deepEqual(f.loadPins(), f.journalPins)
    assert.equal(f.events.at(-1), 'custody:after')
    assert.ok(!f.events.includes(`commit:${f.archiveUser}`))
    if (condition !== 'wrongCount') assert.ok(!f.events.includes(`open:${f.archiveUser}`))
    const read = await f.run('archive-inspect')
    assert.deepEqual(read.result, { state: 'unknown' })
  }
})

test('a lost attestation or archive COMMIT reply permits receipt inspection only, without new authority', async () => {
  for (const [scenario, committed] of [['archive_attestor', false], ['archive_controller', true], ['after custody', true]]) {
    const f = fixture(scenario === 'after custody' ? { loseAfter: true } : { lostCommit: scenario })
    await assert.rejects(f.run('archive'), /synthetic/u)
    assert.deepEqual(f.loadPins(), f.journalPins)
    const beforeRetry = f.events.length
    await assert.rejects(f.run('archive'), /archive_journal_already_reserved/u)
    assert.deepEqual(f.events.slice(beforeRetry), ['custody:before'])
    const beforeInspect = f.events.length, readCount = f.reads.length
    const result = await f.run('archive-inspect')
    assert.deepEqual(result.result, committed ? f.receipt : { state: 'unknown' })
    assert.deepEqual(f.reads.slice(readCount), ['journal'])
    assert.deepEqual(f.events.slice(beforeInspect), [`open:${f.inspectUser}`, 'inspect:receipt', `commit:${f.inspectUser}`, `close:${f.inspectUser}`])
    assert.equal(f.events.filter(event => event === 'archive:exact').length, committed ? 1 : 0)
  }
})

test('receipt-only inspection rejects a response for a different approved batch', async () => {
  const f = fixture({ wrongReceipt: true })
  journal.reserveNativeEmailArchiveJournal(f.journalPath, f.journalPins)
  await assert.rejects(f.run('archive-inspect'), /archive_receipt_invalid/u)
  assert.deepEqual(f.reads, ['journal'])
  assert.deepEqual(f.events, [`open:${f.inspectUser}`, 'inspect:receipt', `close:${f.inspectUser}`])
})
