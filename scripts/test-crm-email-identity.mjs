#!/usr/bin/env node
// Pure synthetic identity/content checks only: no credentials, SQL or provider calls.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
function load(path, dependencies = {}) {
  const module = { exports: {} }
  const output = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  vm.runInNewContext(output, { module, exports: module.exports, Error, Date,
    require: name => dependencies[name] || (name.startsWith('node:') ? require(name) : assert.fail(`Unexpected dependency ${name}`)) })
  return module.exports
}
const identity = load('app_src/lib/crm/emailIdentity.ts')
const reconcile = load('app_src/lib/crm/emailReconciliation.ts', { '@/lib/crm/emailIdentity': identity })
const mailbox = { version: 1, provider: 'gmail', mailboxId: '11111111-1111-4111-8111-111111111111',
  providerAccountId: 'google-stable-subject-123', accountEmail: 'mail@example.test',
  verifiedAt: '2026-10-28T09:00:00.000Z', verifiedConnectionId: 'connection-a' }
const messageIds = ['1a17e730c78d319c', '1a17f5004f29592c', '1a17f5d46a224e0a']
const evidenceInput = { externalMessageId: messageIds[0], externalThreadId: '1a179e9e2743f926',
  senderEmail: 'PERSON@EXAMPLE.TEST', recipientEmails: ['mail@example.test', 'other@example.test'],
  subject: 'A retained subject', receivedAt: '2026-10-27T12:30:40.123Z', snippet: 'Retained snippet',
  bodyText: 'Full body\r\nNot just a snippet', markerReferences: [],
  emailAddressHeaders: { version: 1, from: [{ address: 'person@example.test', displayName: 'Person' }],
    to: [{ address: 'mail@example.test' }, { address: 'other@example.test' }] } }
const current = () => identity.normalizeGmailMessageEvidence(structuredClone(evidenceInput))
const scope = { pipelineId: '587c8746-ecf6-40ae-8c50-e456f99ad555', messageIds, threadId: '1a179e9e2743f926',
  primaryOrganization: { id: 'globus-id', referenceCode: 'gagmco24va588e' },
  organizations: [{ id: 'globus-id', referenceCode: 'gagmco24va588e' }, { id: 'airspace-id', referenceCode: 'gajl1dq5i03jga' }] }
const adoption = changes => reconcile.prepareBoundedLegacyGmailAdoption({ scope: structuredClone(scope), identity: mailbox,
  adoptedAt: '2026-10-28T09:05:00Z', cached: current(), current: current(), ...changes })
let passed = 0
function check(name, work) { work(); passed++; console.log(`PASS ${name}`) }

check('stable mailbox/message keys survive OAuth reconnect, account label and CRM placement changes', () => {
  const reconnected = { ...mailbox, accountEmail: 'renamed@example.test', verifiedConnectionId: 'connection-b' }
  assert.equal(identity.gmailMailboxKey(mailbox), identity.gmailMailboxKey(reconnected))
  assert.equal(identity.gmailMessageSourceKey(mailbox, messageIds[0]), identity.gmailMessageSourceKey(reconnected, messageIds[0]))
  assert.notEqual(identity.gmailMessageSourceKey(mailbox, messageIds[0]), identity.gmailMessageSourceKey({ ...mailbox, providerAccountId: 'other-subject' }, messageIds[0]))
})
check('a verified connection binding requires profile equality and nonfuture verification', () => {
  const valid = { identity: mailbox, connectionId: 'connection-a', profileEmail: 'MAIL@EXAMPLE.TEST', observedAt: '2026-10-28T09:05:00Z' }
  assert.equal(identity.verifyGmailMailboxBinding(valid).providerAccountId, mailbox.providerAccountId)
  const preciseVerification = '2026-10-28T09:00:00.123456+00:00'
  assert.equal(identity.verifyGmailMailboxBinding({ ...valid,
    identity: { ...mailbox, verifiedAt: preciseVerification } }).verifiedAt, preciseVerification,
  'Binding CAS tokens retain PostgreSQL microseconds, never JS-Date truncation')
  for (const change of [{ connectionId: 'connection-b' }, { profileEmail: 'other@example.test' }, { observedAt: '2026-10-27T09:00:00Z' }]) {
    assert.throws(() => identity.verifyGmailMailboxBinding({ ...valid, ...change }))
  }
  assert.throws(() => identity.gmailMailboxKey({ ...mailbox, providerAccountId: '' }))
})
check('normalization preserves milliseconds/full body and normalizes line endings/address ordering only', () => {
  const normalized = current()
  const equivalent = identity.normalizeGmailMessageEvidence({ ...evidenceInput, receivedAt: new Date(evidenceInput.receivedAt),
    bodyText: 'Full body\nNot just a snippet', recipientEmails: [...evidenceInput.recipientEmails].reverse(),
    emailAddressHeaders: { ...evidenceInput.emailAddressHeaders, to: [...evidenceInput.emailAddressHeaders.to].reverse() } })
  assert.equal(identity.assertSameRetainedGmailEvidence(normalized, equivalent), identity.gmailEvidenceHash(normalized))
  assert.equal(normalized.receivedAt, '2026-10-27T12:30:40.123Z')
})
check('every retained identity/content/header field is compared, not merely separately hashed', () => {
  for (const change of [{ messageId: messageIds[1] }, { threadId: 'other-thread' }, { subject: 'changed' },
    { bodyText: 'Full body' }, { snippet: 'changed' }, { receivedAt: '2026-10-27T12:30:40.124Z' },
    { senderEmail: 'other@example.test' }, { recipientEmails: ['mail@example.test'] }, { markerReferences: ['gc1234567'] },
    { emailAddressHeaders: { ...current().emailAddressHeaders, cc: [{ address: 'other@example.test' }] } }]) {
    assert.throws(() => identity.assertSameRetainedGmailEvidence(current(), { ...current(), ...change }))
  }
  assert.equal(identity.normalizeGmailMessageEvidence({ ...evidenceInput, emailAddressHeaders: { version: 1 } }).emailAddressHeaders.from, undefined,
    'Acquisition retains ambiguous headers without granting matching authority')
  assert.throws(() => identity.normalizeGmailMessageEvidence({ ...evidenceInput, receivedAt: 'not-a-time' }))
})
check('new intake provenance records original observation without putting connection/placement in identity', () => {
  const input = { identity: mailbox, ownerEmail: 'owner@example.test', connectionId: 'connection-a',
    observedAt: '2026-10-28T09:05:00Z', intakePipelineId: 'intake-pipeline', intakeWorkspaceOrganizationId: 'intake-workspace', evidence: current() }
  const retained = identity.gmailIntakeProvenance(input)
  assert.equal(retained.observedConnectionId, 'connection-a')
  assert.equal(retained.intakeWorkspaceOrganizationId, 'intake-workspace')
  assert.equal(retained.evidenceHash, identity.gmailEvidenceHash(current()))
  assert.throws(() => identity.gmailIntakeProvenance({ ...input, connectionId: 'connection-b' }))
})
check('legacy admission explicitly remains original-unknown and is replay-stable, not guessed historical provenance', () => {
  const result = adoption()
  assert.equal(result.originalMailboxProvenance, 'unknown')
  assert.equal(result.retainedEvidenceHash, result.currentEvidenceHash)
  assert.equal(result.accountEmail, mailbox.accountEmail)
  assert.equal(JSON.stringify(adoption({ adoptedAt: '2026-10-28T10:00:00Z' })), JSON.stringify(result), 'Preview time cannot alter an unchanged approval')
})
check('legacy bridge cannot expand message set, thread, target pipeline, primary or secondary Account', () => {
  for (const change of [{ messageIds: [messageIds[0]] }, { messageIds: [...messageIds, 'abcdef'] },
    { messageIds: [messageIds[0], messageIds[0], messageIds[2]] }, { threadId: 'other-thread' }, { pipelineId: 'other-pipeline' },
    { primaryOrganization: scope.organizations[1] }, { organizations: [...scope.organizations, { id: 'third', referenceCode: 'ga1234567' }] },
    { organizations: [scope.organizations[0], { id: 'other', referenceCode: 'ga1234567' }] }]) assert.throws(() => adoption({ scope: { ...scope, ...change } }))
  assert.throws(() => adoption({ current: { ...current(), messageId: 'abcdef' } }))
  assert.throws(() => adoption({ cached: { ...current(), bodyText: 'truncated' } }))
  assert.throws(() => adoption({ cached: { ...current(), emailAddressHeaders: { version: 1 } },
    current: { ...current(), emailAddressHeaders: { version: 1 } } }))
})
check('late-contact reconciliation selects only exact IDs and actual-header email, never a thread/body expansion', () => {
  const messages = [current()]
  assert.equal(reconcile.selectLateContactGmailMessages({ messageIds: [messageIds[0]], participantEmail: 'PERSON@example.test', messages }).length, 1)
  for (const change of [{ messageIds: [] }, { messageIds: [messageIds[0], messageIds[0]] }, { messageIds: [messageIds[1]] },
    { participantEmail: 'quoted@example.test' }, { messages: [...messages, { ...current(), messageId: messageIds[1] }] }]) {
    assert.throws(() => reconcile.selectLateContactGmailMessages({ messageIds: [messageIds[0]], participantEmail: 'person@example.test', messages, ...change }))
  }
})
const caseyIds = ['1a18e03ea586cd7e', '1a18f01749eb87a6']
const caseyScope = { ...scope, ownerEmail: 'jarrett@suburbiasandwichco.com',
  connectionId: 'eb13a0fd-c0b2-4ad1-99b7-3bbda178a027', inboundMessageId: '756e4e17-2458-470b-b00c-129c85ee821a',
  intakePipelineId: '0ce9d945-0b71-495b-88ef-420ddd51fd9c', messageIds: caseyIds }
const caseyMailbox = { ...mailbox, verifiedConnectionId: caseyScope.connectionId }
const caseyCurrent = () => ({ ...current(), messageId: caseyIds[0] })
const caseyAdoption = changes => reconcile.prepareCaseyGmailAdoption({ scope: structuredClone(caseyScope), identity: caseyMailbox,
  adoptedAt: '2026-10-28T09:05:00Z', cached: caseyCurrent(), current: caseyCurrent(), ...changes })
check('Casey two-message admission is separate, strictly pinned and permanently original-unknown', () => {
  const proof = caseyAdoption()
  assert.equal(proof.kind, 'reviewed-casey-two-adoption-v1')
  assert.equal(proof.originalMailboxProvenance, 'unknown')
  assert.equal(proof.inboundMessageId, caseyScope.inboundMessageId)
  assert.equal(proof.retainedEvidenceHash, proof.currentEvidenceHash)
  assert.equal(JSON.stringify(caseyAdoption({ adoptedAt: '2026-10-28T10:05:00Z' })), JSON.stringify(proof))
  reconcile.assertCaseyGmailAdoption(proof)
  assert.throws(() => adoption({ scope: caseyScope, cached: caseyCurrent(), current: caseyCurrent() }))
  assert.throws(() => reconcile.assertBoundedGmailLegacyAdoption(proof))
})
check('Casey admission rejects each scope, content, canonical binding and proof alias deviation', () => {
  for (const change of [{ ownerEmail: 'other@example.test' }, { connectionId: 'other' },
    { inboundMessageId: '78a5b2cc-ba50-4a71-a17c-adaf0c1041c2' }, { intakePipelineId: scope.pipelineId },
    { messageIds: [caseyIds[0]] }, { messageIds: [...caseyIds, messageIds[0]] },
    { messageIds: [caseyIds[0], caseyIds[0]] }, { threadId: 'other' }, { pipelineId: 'other' },
    { primaryOrganization: scope.organizations[1] }, { organizations: [scope.organizations[0]] }]) {
    assert.throws(() => caseyAdoption({ scope: { ...caseyScope, ...change } }))
  }
  for (const change of [{ bodyText: 'changed' }, { receivedAt: '2026-10-27T12:30:40.124Z' },
    { messageId: caseyIds[1] }, { threadId: 'other' }, { emailAddressHeaders: { version: 1 } }]) {
    assert.throws(() => caseyAdoption({ current: { ...caseyCurrent(), ...change } }))
  }
  assert.throws(() => caseyAdoption({ identity: mailbox }))
  assert.throws(() => caseyAdoption({ adoptedAt: '2026-10-27T09:05:00Z' }))
  const valid = caseyAdoption()
  const missing = { ...valid }; delete missing.ownerEmail
  for (const proof of [missing, { ...valid, claimedOriginalMailbox: true }, { ...valid, kind: 'bounded-legacy-adoption' },
    { ...valid, originalMailboxProvenance: 'verified' }, { ...valid, mailboxKey: 'gmail:wrong' },
    { ...valid, providerAccountId: '' }, { ...valid, currentEvidenceHash: '0'.repeat(64) },
    { ...valid, selectedMessageIds: [caseyIds.join(',')] },
    { ...valid, relatedOrganizationReferences: ['gagmco24va588e,gajl1dq5i03jga'] }]) {
    assert.throws(() => reconcile.assertCaseyGmailAdoption(proof))
  }
})
console.log(`${passed} Gmail identity and reconciliation checks passed`)
