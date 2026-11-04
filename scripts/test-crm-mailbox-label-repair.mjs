#!/usr/bin/env node
// Pure production-function checks only. SQL, signed tokens and provider data
// below are synthetic; this is NOT PostgreSQL/Google/native runtime proof.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const ownerEmail = 'owner@example.test', connectionId = 'selected-gmail'
const oldEmail = 'old-label@example.test', newEmail = 'current-label@example.test'
const scope = { ownerEmail, connectionId, pipelineId: '11111111-1111-4111-8111-111111111111',
  workspaceOrganizationId: '22222222-2222-4222-8222-222222222222' }
const identity = { subject: 'verified-synthetic-google-subject', email: newEmail, displayName: null }
let passed = 0
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`) }

function fixture() {
  let elapsed = 0, lockWait = 0
  class FixtureDate extends Date { static now() { return Date.now() + elapsed } }
  let db = { accountEmail: oldEmail, updatedAt: '2026-11-04 00:00:00.123456+00', remoteUpdatedAt: null,
    refreshedAt: null, remoteCreatedAt: null, credentialUpdatedAt: '2026-11-03 00:00:00.123456+00', keyVersion: 1, keySeed: 'a', revokedAt: null, scopeValid: true, selected: true,
    app: 'google-mail', source: 'maton', status: 'ACTIVE', authority: { role: 'owner', permissions: { viewCrm: true } },
    mailboxId: '33333333-3333-4333-8333-333333333333', subject: identity.subject, bindingEmail: oldEmail,
    verifiedAt: '2026-11-03 00:00:00.234567+00', activeOperation: null, activeTransition: null, activeInitial: null,
    missingControl: false, failAfterLabel: false }
  const sql = [], audits = []
  const rows = values => ({ rows: values, rowCount: values.length })
  async function query(text, values = []) {
    sql.push({ text, values })
    if (text.startsWith('SET TRANSACTION') || text.startsWith('SELECT pg_advisory')) return rows([])
    if (text.startsWith('SELECT singleton FROM crm_native')) return rows(db.missingControl ? [] : [{ singleton: true }])
    if (text.includes('SELECT active_operation_id')) {
      if (text.includes('FOR UPDATE')) { elapsed += lockWait; lockWait = 0 }
      return rows(db.missingControl ? [] : [{ active_operation_id: db.activeOperation,
        active_transition_id: db.activeTransition, active_initial_enrollment_id: db.activeInitial }])
    }
    if (text.startsWith('SELECT owner_email FROM user_maton_credentials')) return rows([{ owner_email: ownerEmail }])
    if (text.startsWith('SELECT connection.account_email')) {
      if (!db.scopeValid || !db.selected || db.app !== 'google-mail' || db.source !== 'maton' || db.status !== 'ACTIVE') return rows([])
      return rows([{ account_email: db.accountEmail, connection_updated_at: db.updatedAt, remote_updated_at: db.remoteUpdatedAt, remote_created_at: db.remoteCreatedAt,
        last_refreshed_at: db.refreshedAt, api_key_version: db.keyVersion, key_rotated_at: '2026-11-03 00:00:00.123456+00',
        key_revoked_at: db.revokedAt, credential_updated_at: db.credentialUpdatedAt, api_key_ciphertext: Buffer.alloc(32, db.keySeed), api_key_iv: Buffer.alloc(12, 1),
        api_key_tag: Buffer.alloc(16, 2), authority: db.authority }])
    }
    if (text.includes('SELECT mailbox.id::text AS mailbox_id')) return rows(db.mailboxId ? [{ mailbox_id: db.mailboxId,
      provider: 'gmail', provider_account_id: db.subject, account_email: db.bindingEmail, verified_at: db.verifiedAt }] : [])
    if (text.startsWith('UPDATE user_maton_connections SET account_email')) {
      if (db.accountEmail !== values[3] || db.updatedAt !== values[4]) return rows([])
      db.accountEmail = values[2]; db.updatedAt = '2026-11-04 00:00:01.654321+00'
      return rows([{ connection_id: connectionId }])
    }
    if (text.startsWith('SELECT connection.connection_id')) {
      return rows(db.failAfterLabel || values[2] !== db.accountEmail ? [] : [{ connection_id: connectionId }])
    }
    if (text.includes('SELECT mailbox.provider_account_id')) return rows(db.mailboxId ? [{ provider_account_id: db.subject }] : [])
    if (text.startsWith('INSERT INTO crm_email_mailboxes')) {
      db.mailboxId ||= '33333333-3333-4333-8333-333333333333'; db.subject ||= values[1]
      return rows([{ id: db.mailboxId }])
    }
    if (text.startsWith('INSERT INTO crm_email_mailbox_bindings')) {
      db.bindingEmail = values[3]; db.verifiedAt = '2026-11-04 00:00:01.777777+00'; return rows([])
    }
    throw new Error(`Unexpected pure SQL: ${text.slice(0, 100)}`)
  }
  const withTransaction = async callback => {
    const before = structuredClone(db), auditCount = audits.length
    try { return await callback({ query }) } catch (error) { db = before; audits.length = auditCount; throw error }
  }
  const environment = { APP_SESSION_SECRET: 'synthetic-review-hmac-secret-at-least-32-bytes' }
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(read('app_src/lib/persistence/crmEmailIdentity.ts'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, { module, exports: module.exports, Buffer, Date: FixtureDate, Error, process: { env: environment }, require(name) {
    if (name === 'node:crypto') return crypto
    if (name === '@/lib/persistence/postgres') return { query, withTransaction }
    if (name === '@/lib/auditWriter') return { recordAuditEvent: async value => { audits.push(value) } }
    if (name === '@/lib/crm/emailIdentity') return {}
    throw new Error(`Unexpected pure dependency ${name}`)
  } })
  const api = module.exports
  const observation = async () => ({ snapshot: await api.readGmailMailboxLabelRepairSnapshotInPostgres(scope),
    accountEmail: newEmail, observedAt: new Date(Date.now() + elapsed).toISOString() })
  return { api, query, sql, audits, environment, observation, get db() { return db },
    setElapsed: value => { elapsed = value }, advanceOnControlLock: value => { lockWait = value } }
}

await check('preview is a short-lived subject-bound HMAC without writes or raw subject disclosure', async () => {
  const f = fixture(), observation = await f.observation()
  const review = f.api.prepareGmailMailboxLabelRepairPreview({ observation, identity })
  assert.equal(review.required, true); assert.equal(review.oldAccountEmail, oldEmail); assert.equal(review.newAccountEmail, newEmail)
  assert.match(review.expectedDigest, /^[a-f0-9]{64}$/)
  assert.ok(Date.parse(review.expiresAt) > Date.now() && Date.parse(review.expiresAt) <= Date.now() + 300_000)
  assert.equal(JSON.stringify(review).includes(identity.subject), false)
  assert.equal(f.sql.some(call => /^(INSERT|UPDATE)/.test(call.text)), false)
  assert.equal(f.audits.length, 0)
  assert.equal(observation.snapshot.connectionUpdatedAt, '2026-11-04 00:00:00.123456+00')
})
await check('apply takes control then credential before connection; label and same canonical binding commit together', async () => {
  const f = fixture(), observation = await f.observation(), originalMailbox = f.db.mailboxId
  const review = f.api.prepareGmailMailboxLabelRepairPreview({ observation, identity }); f.sql.length = 0
  const result = await f.api.applyGmailMailboxLabelRepairInPostgres({ observation, identity, ...review })
  assert.equal(result.connectionLabelUpdated, true); assert.equal(result.verified, true)
  assert.equal(result.mailboxId, originalMailbox); assert.equal(f.db.accountEmail, newEmail); assert.equal(f.db.bindingEmail, newEmail)
  assert.match(f.sql[0].text, /publication_control.*FOR UPDATE/s)
  const credential = f.sql.findIndex(call => call.text.includes('owner_email FROM user_maton_credentials'))
  const connection = f.sql.findIndex(call => call.text.startsWith('SELECT connection.account_email'))
  assert.ok(credential > 0 && credential < connection)
  assert.match(f.sql[connection].text, /FOR UPDATE OF connection FOR SHARE OF credential/)
  assert.equal(f.audits.length, 2)
  assert.equal(JSON.stringify(f.audits).includes(identity.subject), false)
  assert.deepEqual(f.audits.map(value => value.eventType), ['crm.mailbox_identity.verified', 'crm.mailbox_connection_label.corrected'])
  assert.equal(f.sql.some(call => /crm_email_sources|crm_inbound_messages|crm_interactions/.test(call.text)), false)
})
await check('valid populated legacy key version zero is pinned without credential rotation or reconnect', async () => {
  const f = fixture(); f.db.keyVersion = 0
  const observation = await f.observation(), review = f.api.prepareGmailMailboxLabelRepairPreview({ observation, identity })
  assert.equal(observation.snapshot.keyVersion, 0)
  await f.api.applyGmailMailboxLabelRepairInPostgres({ observation, identity, ...review })
  assert.equal(f.db.keyVersion, 0)
  assert.equal(f.sql.some(call => /^UPDATE user_maton_credentials|DELETE FROM user_maton|INSERT INTO user_maton/.test(call.text)), false)
})
await check('missing old label can be reviewed, already-current labels cannot be applied, and snapshot key order is canonical', async () => {
  const f = fixture(); f.db.accountEmail = null
  const observation = await f.observation(), review = f.api.prepareGmailMailboxLabelRepairPreview({ observation, identity })
  assert.equal(review.oldAccountEmail, ''); assert.equal(review.required, true)
  observation.snapshot = Object.fromEntries(Object.entries(observation.snapshot).reverse())
  await f.api.applyGmailMailboxLabelRepairInPostgres({ observation, identity, ...review })
  assert.equal(f.db.accountEmail, newEmail)
  const current = await f.observation(), noChange = f.api.prepareGmailMailboxLabelRepairPreview({ observation: current, identity })
  assert.equal(noChange.required, false)
  await assert.rejects(f.api.applyGmailMailboxLabelRepairInPostgres({ observation: current, identity, ...noChange }))
})
await check('old HMAC, changed expiry/profile/subject, expired preview, stale observation and weak secret cannot apply', async () => {
  for (const change of [input => { input.expectedDigest = 'a'.repeat(64) },
    input => { input.expiresAt = new Date(Date.now() + 100_000).toISOString() },
    input => { input.expiresAt = new Date(Date.now() - 1).toISOString() },
    input => { input.observation.accountEmail = 'other@example.test' },
    input => { input.identity = { ...identity, subject: 'different-subject' } },
    input => { input.observation.observedAt = new Date(Date.now() - 31_000).toISOString() }]) {
    const f = fixture(), observation = await f.observation(), review = f.api.prepareGmailMailboxLabelRepairPreview({ observation, identity })
    const input = { observation, identity, ...review }; change(input)
    await assert.rejects(f.api.applyGmailMailboxLabelRepairInPostgres(input))
    assert.equal(f.db.accountEmail, oldEmail); assert.equal(f.audits.length, 0)
  }
  const f = fixture(), observation = await f.observation(); f.environment.APP_SESSION_SECRET = 'short'
  assert.throws(() => f.api.prepareGmailMailboxLabelRepairPreview({ observation, identity }))
})
await check('all current CAS, credential, selection and authority changes hold without partial writes', async () => {
  for (const mutate of [db => { db.accountEmail = 'newer-label@example.test' }, db => { db.updatedAt += ' changed' },
    db => { db.remoteUpdatedAt = '2026-11-04 00:00:02.123456+00' }, db => { db.refreshedAt = '2026-11-04 00:00:02.123456+00' },
    db => { db.keyVersion++ }, db => { db.keySeed = 'b' }, db => { db.revokedAt = 'now' }, db => { db.selected = false },
    db => { db.credentialUpdatedAt = '2026-11-04 00:00:00.123456+00' }, db => { db.remoteCreatedAt = '2026-11-04 00:00:00.123456+00' },
    db => { db.status = 'INACTIVE' }, db => { db.app = 'google-calendar' }, db => { db.source = 'manual' },
    db => { db.scopeValid = false }, db => { db.authority.permissions.viewCrm = false }, db => { db.subject = 'different-subject' },
    db => { db.activeOperation = 'unresolved' }, db => { db.activeTransition = 'unresolved' },
    db => { db.activeInitial = 'reserved' }, db => { db.missingControl = true }]) {
    const f = fixture(), observation = await f.observation(), review = f.api.prepareGmailMailboxLabelRepairPreview({ observation, identity })
    mutate(f.db); const before = structuredClone(f.db)
    await assert.rejects(f.api.applyGmailMailboxLabelRepairInPostgres({ observation, identity, ...review }))
    assert.deepEqual(f.db, before); assert.equal(f.audits.length, 0)
  }
})
await check('a late binding failure rolls back the label; successful replay cannot update it again', async () => {
  const f = fixture(), observation = await f.observation(), review = f.api.prepareGmailMailboxLabelRepairPreview({ observation, identity })
  f.db.failAfterLabel = true
  await assert.rejects(f.api.applyGmailMailboxLabelRepairInPostgres({ observation, identity, ...review }))
  assert.equal(f.db.accountEmail, oldEmail); assert.equal(f.db.bindingEmail, oldEmail); assert.equal(f.audits.length, 0)
  f.db.failAfterLabel = false
  await f.api.applyGmailMailboxLabelRepairInPostgres({ observation, identity, ...review })
  await assert.rejects(f.api.applyGmailMailboxLabelRepairInPostgres({ observation, identity, ...review }))
  assert.equal(f.db.accountEmail, newEmail); assert.equal(f.audits.length, 2)
})
await check('lock waits cannot extend review expiry or make a stale profile observation current', async () => {
  for (const expiryOnly of [false, true]) {
    const f = fixture(), initial = await f.observation(), review = f.api.prepareGmailMailboxLabelRepairPreview({ observation: initial, identity })
    if (expiryOnly) f.setElapsed(299_000)
    const observation = expiryOnly ? await f.observation() : initial
    f.advanceOnControlLock(expiryOnly ? 2000 : 31_000)
    await assert.rejects(f.api.applyGmailMailboxLabelRepairInPostgres({ observation, identity, ...review }))
    assert.equal(f.db.accountEmail, oldEmail); assert.equal(f.db.bindingEmail, oldEmail)
    assert.equal(f.sql.some(call => call.text.startsWith('UPDATE user_maton_connections')), false)
    assert.equal(f.audits.length, 0)
  }
})
await check('a current different canonical subject cannot even preview and no subject is inferred from a label', async () => {
  const f = fixture(); f.db.subject = 'preexisting-different-subject'
  assert.throws(() => f.api.prepareGmailMailboxLabelRepairPreview({ observation: { snapshot: {}, accountEmail: newEmail,
    observedAt: new Date().toISOString() }, identity: { ...identity, subject: '' } }))
  assert.throws(() => f.api.prepareGmailMailboxLabelRepairPreview({ observation: { snapshot: { providerAccountId: f.db.subject },
    accountEmail: newEmail, observedAt: new Date().toISOString() }, identity }))
  assert.equal(f.db.accountEmail, oldEmail); assert.equal(f.audits.length, 0)
})

function observationFixture({ drift = false, oversized = false } = {}) {
  const source = read('app_src/lib/crm/emailIngestion.ts'), parsed = ts.createSourceFile('emailIngestion.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['GMAIL_APP','EMAIL_PATTERN','SafeEmailIngestionError','asRecord','selectedMailboxes','gmailJson','gmailMailboxProfile',
    'readGmailMailboxProfileForOwner','readGmailMailboxLabelRepairObservationForOwner']
  const declarations = names.map(name => {
    const declaration = parsed.statements.find(statement => (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      && statement.name?.text === name || ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some(value => value.name.getText(parsed) === name))
    assert.ok(declaration, name); return declaration.getText(parsed).replace(/^export\s+/u, '')
  }).join('\n')
  let captures = 0, gets = 0
  const context = { Buffer, Date, Error, AbortSignal, setTimeout, clearTimeout,
    query: async () => ({ rows: [{ owner_email: ownerEmail, connection_id: connectionId, account_email: oldEmail }] }),
    readGmailMailboxLabelRepairSnapshotInPostgres: async value => { assert.deepEqual(value, scope); captures++
      return { ...scope, accountEmail: oldEmail, version: drift && captures > 1 ? 2 : 1 } },
    matonFetch: async (url, init, binding) => {
      gets++; assert.equal(url, '/google-mail/gmail/v1/users/me/profile'); assert.equal(init.method, 'GET')
      assert.equal(binding.ownerEmail, ownerEmail); assert.equal(binding.boundConnectionId, connectionId)
      return Response.json({ emailAddress: newEmail, ...(oversized ? { padding: 'x'.repeat(8192) } : {}) })
    } }
  vm.runInNewContext(ts.transpileModule(`${declarations}\nglobalThis.api={readGmailMailboxProfileForOwner,readGmailMailboxLabelRepairObservationForOwner}`, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  return { api: context.api, get captures() { return captures }, get gets() { return gets } }
}
await check('normal ingestion remains mismatch-strict while separately named observation is read-only and metadata-fenced', async () => {
  const f = observationFixture()
  await assert.rejects(f.api.readGmailMailboxProfileForOwner({ ownerEmail, connectionId }), /does not match/)
  const observation = await f.api.readGmailMailboxLabelRepairObservationForOwner(scope)
  assert.equal(observation.accountEmail, newEmail); assert.equal(observation.snapshot.accountEmail, oldEmail)
  assert.equal(f.captures, 2); assert.equal(f.gets, 2)
  await assert.rejects(observationFixture({ drift: true }).api.readGmailMailboxLabelRepairObservationForOwner(scope), /changed/)
  await assert.rejects(observationFixture({ oversized: true }).api.readGmailMailboxLabelRepairObservationForOwner(scope), /could not/)
})
console.log(`${passed} pure mailbox label repair groups passed; SQL/provider/Google verification remain synthetic`)
