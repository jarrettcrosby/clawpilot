#!/usr/bin/env node
// Synthetic database and custody transport, real DAL sequencing, signatures,
// target fingerprint and owner-only durable journal. No live endpoints.
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
const approval = load('lib/crm/legacyEmailAccountRepairApproval', shared)
const journal = load('lib/crm/nativeEmailAccountRepairJournal', shared)
const custody = load('lib/crm/nativeEmailRecoveryCustodyProof', shared)
const uncalled = () => assert.fail('repair must not initialize native transport or signing')
const transport = load('lib/crm/nativeEmailRecoveryCliTransport', {
  ...shared, './nativeEmailRecoveryDuplexRunner': { createNativeEmailRecoveryDuplexCommandRunner: uncalled },
  './nativeEmailRecoveryReadyProof': { createNativeEmailRecoveryReadyChallenge: uncalled },
})
const dal = load('lib/persistence/crmLegacyEmailAccountRepair', {
  '../crm/nativeEmailPublication': protocol, '../crm/legacyEmailAccountRepairApproval': approval,
})
const { nativeEmailCanonicalJson: json, nativeEmailDigest: hash } = protocol
const sha = value => crypto.createHash('sha256').update(value).digest('hex')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const now = () => Math.floor(Date.now() / 1000)
const pem = key => key.export({ format: 'pem', type: 'spki' })
const sign = (proof, key) => ({
  proof, signature: crypto.sign('sha256', Buffer.from(json(proof), 'ascii'),
    { key, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64'),
})
const operatorKey = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 })
const custodyKey = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 })
const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'clawpilot-account-repair-operator-'))
after(() => fs.rmSync(root, { recursive: true }))

function fixture({ lostCommit, badCustody, wrongDbClock, changedReview, fenceAfterLost = false,
  fenceBeforeWriteLost = false, journalAfterAttestChanged = false } = {}) {
  const directory = fs.mkdtempSync(join(root, 'case-')), journalPath = join(directory, 'repair.json')
  const events = [], reads = [], nonces = new Set()
  let openRole = null, attested = false, committed = false
  const native = {
    projectId: id(1), environmentId: id(2), serviceId: id(3), deploymentId: id(4), deploymentInstanceId: id(5), replicaId: id(6),
    nativeInstanceId: 'native-fixture', database: 'native_fixture', databasePrincipal: 'native_writer@localhost',
    serviceUserId: 'service-fixture', oauthClientId: 'oauth-fixture', cliSourceHash: hash('cli'), imagePackageHash: hash('image'),
    mariaStoreFingerprint: hash('native database'),
  }
  const target = {
    outboxId: id(10), localId: id(11), pipelineId: id(12), workspaceId: id(13), globalId: 'gi1234567', nativeId: id(14),
    oldPrimaryId: id(15), newPrimaryId: id(16), oldPrimaryNativeId: id(17), newPrimaryNativeId: id(18),
  }
  const ca = '-----BEGIN CERTIFICATE-----\nsynthetic-only\n-----END CERTIFICATE-----'
  const cluster = {
    host: 'fixture.invalid', port: 5432, database: 'fixture_database', systemIdentifier: '18446744073709551615',
    databaseOid: '4294967295', tlsCaSha256: sha(ca),
  }
  const targetFingerprint = hash({ version: 1, purpose: 'clawpilot-native-email-account-repair-destination-v1',
    native: transport.nativeEmailRecoveryCliTargetFingerprint(native), database: cluster })
  const operationId = id(19), reviewDigest = hash('review digest'), fenceEpoch = id(20)
  const plan = {
    version: 1, purpose: 'clawpilot-exact-legacy-email-account-repair-review-v1', target, generation: 11,
    oldPrimaryReference: 'ga1234567', newPrimaryReference: 'ga1234568', sourceDigest: hash('old source'),
    outboxDigest: hash('old outbox'), edgeDigest: hash('old edge'), nextPayloadDigest: hash('new payload'),
  }
  const start = now()
  const envelope = sign({
    version: 1, purpose: 'clawpilot-private-legacy-email-account-repair-v1', keyId: 'reviewer',
    operationId, reviewDigest, targetFingerprint, fenceEpoch, issuedAt: start - 5, expiresAt: start + 110,
  }, operatorKey.privateKey)
  const approvalDigest = hash(envelope)
  const scopePins = { operationId, reviewDigest, approvalDigest, journal: journalPath }
  const journalPins = {
    version: 1, purpose: 'clawpilot-private-native-email-account-repair-journal-v1', operationId,
    reviewDigest, approvalDigest, targetFingerprint, fenceEpoch,
  }
  const receipt = { state: 'committed', operationId, reviewDigest, receiptHash: hash('receipt') }
  const repairUser = 'repair_fixture', attestorUser = 'attest_fixture', previewUser = 'preview_fixture', inspectUser = 'inspect_fixture'
  const socketPath = '/private/tmp/synthetic-custodian.sock'
  const custodianUid = process.geteuid() === 0 ? 1 : 0
  const configFor = action => ({
    version: 1, purpose: 'clawpilot-private-native-email-account-repair', action, native,
    postgres: { ...cluster, user: action === 'repair' ? repairUser : action === 'repair-preview' ? previewUser : inspectUser },
    ...(action === 'repair-preview' ? { target } : action === 'repair-inspect' ? scopePins : {
      ...scopePins, target, attestorUser, release: { keyId: 'reviewer', publicKey: pem(operatorKey.publicKey) },
      custody: { keyId: 'custodian', publicKey: pem(custodyKey.publicKey), socketPath, uid: custodianUid,
        fenceEpoch, expiresAt: start + 180, producerInventoryHash: hash('producer inventory') },
    }),
  })
  const defaultSecrets = { postgresPassword: 'synthetic-controller-password', postgresTlsCa: ca }
  const repairSecrets = { ...defaultSecrets, attestorPassword: 'synthetic-attestor-password' }
  const nativeScope = hash({ version: 1, purpose: 'clawpilot-native-email-account-repair-custody-operation-v1', operationId })
  const requestScope = hash({ version: 1, purpose: 'clawpilot-native-email-account-repair-custody-request-v1',
    action: 'repair', target, reviewDigest, approvalDigest, targetFingerprint })
  const loadPins = () => JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  const api = load('lib/crm/nativeEmailAccountRepairOperator', {
    ...shared, '../persistence/crmLegacyEmailAccountRepair': dal, './legacyEmailAccountRepairApproval': approval,
    './nativeEmailAccountRepairJournal': journal, './nativeEmailRecoveryCliTransport': {
      nativeEmailRecoveryCliTargetFingerprint: transport.nativeEmailRecoveryCliTargetFingerprint,
      createNativeEmailRecoveryCliTransport: uncalled,
    },
    './nativeEmailRecoveryCustodyProof': custody, './nativeEmailRecoveryCustodySocket': {
      async requestNativeEmailRecoveryCustody({ socketPath: socket, custodianUid: uid, challenge }) {
        assert.equal(openRole, null, 'each database login must be closed before a custody probe')
        assert.equal(socket, socketPath)
        assert.equal(uid, custodianUid)
        assert.equal(challenge.purpose, 'clawpilot-native-email-recovery-custody-challenge-v2')
        assert.equal(challenge.operationId, nativeScope)
        assert.equal(challenge.requestFingerprint, requestScope)
        assert.equal(challenge.targetFingerprint, targetFingerprint)
        const storeBinding = shared['./nativeEmailRecoveryStoreBinding']
        assert.equal(challenge.storeBindingFingerprint, storeBinding.nativeEmailRecoveryStoreBindingFingerprint({
          targetFingerprint, mariaStoreFingerprint: native.mariaStoreFingerprint,
          postgresStoreFingerprint: storeBinding.nativeEmailPostgresStoreFingerprint({
            database: cluster.database, databaseOid: cluster.databaseOid, systemIdentifier: cluster.systemIdentifier,
          }),
        }))
        assert.equal(challenge.controllerConfigHash, sha(json(configFor('repair')) + '\n'))
        assert.equal(challenge.fenceEpoch, fenceEpoch)
        assert.equal(challenge.producerInventoryHash, hash('producer inventory'))
        assert.match(challenge.nonce, /^[a-f0-9]{64}$/u)
        assert.ok(!nonces.has(challenge.nonce))
        nonces.add(challenge.nonce)
        events.push(`custody:${challenge.phase}`)
        if (fenceAfterLost && challenge.phase === 'after') throw Error('synthetic after-custody failure')
        if (fenceBeforeWriteLost && attested && challenge.phase === 'before') throw Error('synthetic before-write custody failure')
        return sign({
          ...challenge, purpose: 'clawpilot-native-email-recovery-custody-v2', keyId: 'custodian', issuedAt: now(),
          retainedClosure: true, postgresObservationHash: hash('postgres observation'), mariaObservationHash: hash('maria observation'),
          ...(badCustody ? { storeBindingFingerprint: hash('unrelated store') } : {}),
        }, custodyKey.privateKey)
      },
    },
    './nativeEmailRecoveryPrivatePostgres': {
      createNativeEmailRecoveryPrivatePostgres(options) {
        const { user, ...identity } = options.target
        const { tlsCaSha256: ignored, ...clusterWithoutCa } = cluster
        void ignored
        assert.deepEqual(identity, clusterWithoutCa)
        assert.equal(options.tlsCa, ca)
        assert.equal(options.password, user === attestorUser ? repairSecrets.attestorPassword : defaultSecrets.postgresPassword)
        assert.equal(openRole, null, 'database sessions must not overlap')
        if ([attestorUser, repairUser].includes(user)) assert.deepEqual(loadPins(), journalPins, 'persist journal before database write')
        openRole = user
        events.push(`open:${user}`)
        let transactions = 0
        const rows = (...values) => ({ rows: values })
        return {
          async transaction(run) {
            assert.equal(++transactions, 1, 'one-shot connection')
            const result = await run({
              async query(sql, args) {
                assert.equal(openRole, user)
                if (sql.includes('session_user AS login')) {
                  assert.ok([attestorUser, repairUser].includes(user))
                  events.push(`identity:${user}`)
                  return rows({ login: user, role: user, second: wrongDbClock ? start + 1000 : now() })
                }
                if (sql.includes('preview_account_repair')) {
                  assert.ok([previewUser, attestorUser].includes(user))
                  assert.deepEqual(args, [target])
                  events.push(`preview:${user}`)
                  return rows({ result: { review: plan, reviewDigest: changedReview ? hash('drift') : reviewDigest } })
                }
                if (sql.includes('INSERT INTO crm_legacy_email_retirement.account_repair_approvals')) {
                  assert.equal(user, attestorUser)
                  assert.deepEqual(args, [operationId, plan.generation, reviewDigest, approvalDigest, fenceEpoch, envelope.proof.expiresAt])
                  assert.equal(attested, false)
                  assert.deepEqual(loadPins(), journalPins)
                  events.push('attest:insert')
                  return rows()
                }
                if (sql.includes('repair_account_links')) {
                  assert.equal(user, repairUser)
                  assert.ok(attested && !committed)
                  assert.deepEqual(args, [operationId, target, approvalDigest])
                  events.push('repair:call')
                  return rows({ result: receipt })
                }
                assert.match(sql, /read_account_repair/u)
                assert.equal(user, inspectUser)
                assert.deepEqual(args, [operationId, approvalDigest])
                events.push('inspect:receipt')
                return rows({ result: committed ? receipt : { state: 'unknown' } })
              },
            })
            if (user === attestorUser) attested = true
            if (user === repairUser) committed = true
            events.push(`commit:${user}`)
            if (lostCommit === user) throw Error('synthetic COMMIT response lost')
            return result
          },
          async close() {
            assert.equal(openRole, user)
            openRole = null
            events.push(`close:${user}`)
          },
        }
      },
    },
  })
  function run(action, tweaks = {}) {
    const config = tweaks.config ?? configFor(action)
    return api.runNativeEmailAccountRepairPrivateOperator({
      action, configHash: tweaks.configHash ?? sha(json(config) + '\n'),
      explicitOperation: Object.hasOwn(tweaks, 'explicitOperation') ? tweaks.explicitOperation : action === 'repair' ? operationId : undefined,
      readConfig: () => config,
      readSecrets: () => tweaks.secrets ?? (action === 'repair' ? repairSecrets : defaultSecrets),
      readApproval() {
        reads.push('approval')
        assert.equal(action, 'repair')
        return tweaks.envelope ?? envelope
      },
      readJournal(filename) {
        reads.push('journal')
        assert.equal(filename, journalPath)
        return tweaks.journal ?? (journalAfterAttestChanged && attested ? { ...loadPins(), fenceEpoch: id(99) } : loadPins())
      },
    })
  }
  return { run, events, reads, configFor, repairSecrets, defaultSecrets, journalPath, journalPins, loadPins, targetFingerprint,
    plan, reviewDigest, receipt, repairUser, attestorUser, previewUser, inspectUser,
    custodySelection: api.nativeEmailAccountRepairCustodySelection, custodyInput: { target, operationId, reviewDigest, approvalDigest, targetFingerprint },
    expectedCustodyPins: { operationId: nativeScope, requestFingerprint: requestScope } }
}

test('independent custodian derives stable domain-separated pins without any credential or transport', () => {
  const f = fixture()
  const selected = f.custodySelection(f.custodyInput)
  assert.deepEqual(selected, f.expectedCustodyPins)
  assert.ok(Object.isFrozen(selected))
  for (const key of ['reviewDigest', 'approvalDigest', 'targetFingerprint']) {
    assert.notEqual(f.custodySelection({ ...f.custodyInput, [key]: hash('other ' + key) }).requestFingerprint, selected.requestFingerprint)
  }
  assert.notEqual(f.custodySelection({ ...f.custodyInput, operationId: id(99) }).operationId, selected.operationId)
  assert.deepEqual(f.events, [])
})

test('preview and receipt inspection use dedicated one-shot read paths without approval, custody or writes', async () => {
  const f = fixture()
  const preview = await f.run('repair-preview')
  assert.deepEqual(preview, { action: 'repair-preview', targetFingerprint: f.targetFingerprint,
    result: { review: f.plan, reviewDigest: f.reviewDigest, generation: f.plan.generation } })
  assert.deepEqual(f.events, [`open:${f.previewUser}`, `preview:${f.previewUser}`, `commit:${f.previewUser}`, `close:${f.previewUser}`])
  assert.deepEqual(f.reads, [])
  assert.equal(fs.existsSync(f.journalPath), false)
  journal.reserveNativeEmailAccountRepairJournal(f.journalPath, f.journalPins)
  const result = await f.run('repair-inspect')
  assert.deepEqual(result.result, { state: 'unknown' })
  assert.deepEqual(f.reads, ['journal'])
  assert.deepEqual(f.events.slice(4), [`open:${f.inspectUser}`, 'inspect:receipt', `commit:${f.inspectUser}`, `close:${f.inspectUser}`])
})

test('exact repair uses separate direct logins and two fresh before proofs, and retains pins before either login', async () => {
  const f = fixture()
  const result = await f.run('repair')
  assert.deepEqual(result.result, f.receipt)
  assert.equal(result.successfulObservations, 3)
  assert.match(result.observationsDigest, /^[a-f0-9]{64}$/u)
  assert.deepEqual(f.loadPins(), f.journalPins)
  assert.deepEqual(f.events, ['custody:before', `open:${f.attestorUser}`, `identity:${f.attestorUser}`,
    `preview:${f.attestorUser}`, 'attest:insert', `commit:${f.attestorUser}`, `close:${f.attestorUser}`,
    'custody:before', `open:${f.repairUser}`, `identity:${f.repairUser}`, 'repair:call',
    `commit:${f.repairUser}`, `close:${f.repairUser}`, 'custody:after'])
})

test('wrong authority, cross-mode config, role or credential reuse and foreign retained pins fail before SQL', async () => {
  const f = fixture()
  await assert.rejects(f.run('repair-preview', { config: f.configFor('repair') }), /shape/u)
  await assert.rejects(f.run('repair', { explicitOperation: id(99) }), /explicit_operation/u)
  await assert.rejects(f.run('repair', { config: { ...f.configFor('repair'), attestorUser: f.repairUser } }), /role_separation/u)
  await assert.rejects(f.run('repair', { secrets: { ...f.repairSecrets, attestorPassword: f.repairSecrets.postgresPassword } }), /role_separation/u)
  await assert.rejects(f.run('repair-preview', { secrets: f.repairSecrets }), /shape/u)
  await assert.rejects(f.run('repair', { secrets: { ...f.repairSecrets, postgresTlsCa: 'foreign CA' } }), /credentials/u)
  const cfg = f.configFor('repair')
  await assert.rejects(f.run('repair', { config: { ...cfg, release: { keyId: 'another-id', publicKey: cfg.custody.publicKey } } }), /independent_anchors/u)
  await assert.rejects(f.run('repair', { config: { ...cfg, native: { ...cfg.native, deploymentId: id(99) } } }), /approval_scope/u)
  await assert.rejects(f.run('repair-inspect', { journal: { ...f.journalPins, approvalDigest: hash('unrelated') } }), /journal_changed/u)
  assert.deepEqual(f.events, [])
  assert.equal(fs.existsSync(f.journalPath), false)
})

test('custody, DB-time approval or review drift cannot reach the repair writer', async () => {
  const bad = fixture({ badCustody: true })
  await assert.rejects(bad.run('repair'), /custody_binding/u)
  assert.deepEqual(bad.events, ['custody:before'])
  assert.equal(fs.existsSync(bad.journalPath), false)
  for (const change of ['wrongDbClock', 'changedReview']) {
    const f = fixture({ [change]: true })
    await assert.rejects(f.run('repair'), change === 'wrongDbClock' ? /approval_expiry/u : /review_changed/u)
    assert.deepEqual(f.loadPins(), f.journalPins)
    assert.ok(!f.events.includes('attest:insert') && !f.events.includes(`open:${f.repairUser}`))
    assert.equal(f.events.at(-1), 'custody:after')
  }
  for (const change of ['fenceBeforeWriteLost', 'journalAfterAttestChanged']) {
    const f = fixture({ [change]: true })
    await assert.rejects(f.run('repair'), change === 'fenceBeforeWriteLost' ? /before-write custody failure/u : /journal_changed/u)
    assert.ok(f.events.includes(`close:${f.attestorUser}`) && !f.events.includes(`open:${f.repairUser}`))
    assert.deepEqual(f.loadPins(), f.journalPins)
    assert.equal(f.events.at(-1), 'custody:after')
  }
})

test('lost commit response or later custody loss preserves the reservation and permits receipt-only inspection', async () => {
  for (const scenario of ['attest_fixture', 'repair_fixture', 'after custody']) {
    const f = fixture(scenario === 'after custody' ? { fenceAfterLost: true } : { lostCommit: scenario })
    await assert.rejects(f.run('repair'), /synthetic/u)
    assert.deepEqual(f.loadPins(), f.journalPins)
    const beforeRetry = f.events.length
    await assert.rejects(f.run('repair'), /journal_already_reserved/u)
    assert.deepEqual(f.events.slice(beforeRetry), ['custody:before'])
    const beforeInspect = f.events.length, previousReads = f.reads.length
    const inspected = await f.run('repair-inspect')
    assert.deepEqual(inspected.result, scenario === 'attest_fixture' ? { state: 'unknown' } : f.receipt)
    assert.deepEqual(f.reads.slice(previousReads), ['journal'])
    assert.deepEqual(f.events.slice(beforeInspect), [`open:${f.inspectUser}`, 'inspect:receipt', `commit:${f.inspectUser}`, `close:${f.inspectUser}`])
    assert.equal(f.events.filter(event => event === 'repair:call').length, scenario === 'attest_fixture' ? 0 : 1)
  }
})
