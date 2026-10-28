#!/usr/bin/env node
// Actual outbound orchestration/staging functions; synthetic provider receipts
// and in-memory persistence only. No credentials, Gmail calls, SQL or sends.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
function declarations(path, names) {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
  return names.map(name => {
    const declaration = source.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name && item.body)
    assert.ok(declaration, `Actual production declaration ${name} exists`)
    return declaration.getText(source).replace(/^export\s+/, '')
  }).join('\n')
}
const identitySource = ts.transpileModule(read('app_src/lib/crm/emailIdentity.ts'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText
const identityModule = { exports: {} }
vm.runInNewContext(identitySource, { module: identityModule, exports: identityModule.exports,
  require: name => name.startsWith('node:') ? require(name) : assert.fail(`Unexpected ${name}`) })
const emailIdentity = identityModule.exports
const source = ts.transpileModule(declarations('app_src/lib/crm/integrationActions.ts', [
  'interactionLinks', 'stageActionInteraction', 'recordedGmailSentSourceSnapshot', 'sendEmailAction',
]), { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText

const owner = 'owner@example.test', mailbox = 'mailbox@example.test', sender = 'alias@example.test'
const pipelineId = '11111111-1111-4111-8111-111111111111'
const actionId = '22222222-2222-4222-8222-222222222222'
const mailboxId = '33333333-3333-4333-8333-333333333333'
const canonicalSourceId = '44444444-4444-4444-8444-444444444444'
const inboundMessageId = '55555555-5555-4555-8555-555555555555'
const originalConnection = 'original-verified-connection'
const providerMessage = '1a17abcd01234567', providerThread = '1a17abcd01234560'
const verifiedIdentity = { version: 1, provider: 'gmail', mailboxId, providerAccountId: 'stable-google-subject',
  accountEmail: mailbox, verifiedAt: '2026-10-01T00:00:00.000Z', verifiedConnectionId: originalConnection }
const target = { entity: 'contacts', id: '66666666-6666-4666-8666-666666666666', referenceCode: 'gc1234567',
  organizationId: '77777777-7777-4777-8777-777777777777', email: 'customer@example.test', emailOptOut: false, suiteCrmId: 'native-contact' }

function harness(options = {}) {
  const events = [], selections = [], bindingReads = [], sends = [], captures = [], stages = [], completions = []
  let durable = { externalId: options.externalId || null, responseSummary: plain(options.responseSummary || {}) }
  let currentConnection = originalConnection
  let captureFailures = options.captureFailures || 0
  let stageFailures = options.stageFailures || 0
  let knownIdentity = options.identity === undefined ? verifiedIdentity : options.identity
  const context = {
    Date, Error, UUID_PATTERN: /^[0-9a-f-]{36}$/i,
    PermanentCrmIntegrationActionError: class extends Error {},
    verifyGmailMailboxBinding: emailIdentity.verifyGmailMailboxBinding,
    normalizeEmail: value => {
      if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw new Error('Invalid email')
      return value.trim().toLowerCase()
    },
    cleanString: value => typeof value === 'string' ? value.trim() : '',
    requiredString: value => { if (typeof value !== 'string' || !value.trim()) throw new Error('Required'); return value.trim() },
    objectValue: value => value && typeof value === 'object' ? value : {},
    outboundEmailReferenceCodes: async () => ['gc1234567'],
    appendTextReplyMarkers: text => `${text}\n%gsltgc1234567`, appendHtmlReplyMarkers: html => html,
    base64Url: value => Buffer.from(value).toString('base64url'), gmailMessage: fields => JSON.stringify(fields),
    suiteCrmParentType: entity => entity === 'contacts' ? 'Contacts' : 'Accounts',
    verifiedGmailSelectionForAction: async () => {
      events.push('selection'); selections.push(currentConnection)
      return { selectedConnection: { credentialOwnerEmail: owner, connectionId: currentConnection, accountEmail: mailbox },
        profileEmail: mailbox, senderEmail: sender }
    },
    readVerifiedGmailMailboxIdentityInPostgres: async input => {
      bindingReads.push(plain(input)); events.push('binding')
      if (options.bindingFailure) throw new Error('Synthetic unavailable binding')
      return knownIdentity ? plain(knownIdentity) : null
    },
    matonJson: async (action, app, connectionId, path, init) => {
      assert.equal(path, '/google-mail/gmail/v1/users/me/messages/send')
      assert.equal(init.method, 'POST')
      assert.equal(app, 'google-mail')
      sends.push({ connectionId, body: JSON.parse(init.body) }); events.push('send')
      return { id: providerMessage, threadId: providerThread }
    },
    recordAttemptSucceeded: async (action, externalId, summary) => {
      events.push('receipt'); durable = { externalId, responseSummary: plain(summary) }
      assert.equal(summary.deliveryState, 'delivered')
    },
    captureDeliveredGmailMessage: async input => {
      captures.push(plain(input)); events.push('capture')
      assert.equal(durable.externalId, providerMessage, 'Successful provider ID is durable before capture')
      assert.equal(durable.responseSummary.gmailSourceSnapshot.connectionId, originalConnection)
      assert.equal(durable.responseSummary.deliveryState, 'delivered')
      assert.ok(durable.responseSummary.deliverySentAt)
      assert.equal(input.messageId, providerMessage)
      assert.equal(input.threadId, providerThread)
      if (captureFailures-- > 0 || input.connectionId !== currentConnection) throw new Error('Private provider error must not escape')
      return { canonicalSourceId, inboundMessageId }
    },
    stageCrmRecordInPostgres: async input => {
      stages.push(plain(input)); events.push('stage')
      if (stageFailures-- > 0) throw new Error('Synthetic stage failure')
      return { id: 'stable-action-interaction' }
    },
    completeAction: async (action, externalId, summary) => {
      events.push('complete'); durable = { externalId, responseSummary: plain(summary) }; completions.push(plain(summary))
    },
  }
  vm.runInNewContext(`${source}\nglobalThis.send = sendEmailAction`, context)
  const action = () => ({ id: actionId, pipelineId, actorEmail: owner, provider: 'maton', app: 'google-mail', actionType: 'send_email',
    payload: { recipientEmail: target.email, subject: 'Authored subject', text: 'Authored CRM text' },
    communication: { source: 'organization', accountEmail: mailbox }, ...plain(durable) })
  return { run: () => context.send(action(), target), events, selections, bindingReads, sends, captures, stages, completions,
    durable: () => plain(durable), reselect: value => { currentConnection = value }, verifyLater: () => { knownIdentity = verifiedIdentity } }
}

let passed = 0
async function check(name, work) { await work(); passed++; console.log(`PASS ${name}`) }

await check('new verified send records original identity before exact capture and stages that same canonical source', async () => {
  const h = harness(); await h.run()
  assert.deepEqual(h.events, ['selection', 'binding', 'send', 'receipt', 'capture', 'stage', 'complete'])
  assert.equal(h.sends.length, 1)
  assert.equal(h.bindingReads[0].ownerEmail, owner)
  assert.equal(h.captures[0].connectionId, originalConnection)
  assert.equal(h.captures[0].mailboxIdentity.providerAccountId, verifiedIdentity.providerAccountId)
  const staged = h.stages[0]
  assert.equal(staged.sourceKey, `crm-action:${actionId}`)
  assert.equal(staged.fields.providerMessageId, providerMessage)
  assert.equal(staged.fields.providerThreadId, providerThread)
  assert.equal(staged.fields.metadata.canonicalSourceId, canonicalSourceId)
  assert.equal(staged.fields.metadata.inboundMessageId, inboundMessageId)
  assert.equal(staged.fields.description, 'Authored CRM text', 'Capture must not overwrite authored CRM text with transport markers')
  assert.equal(staged.fields.occurredAt, h.durable().responseSummary.deliverySentAt)
  assert.equal(h.durable().responseSummary.sourceCaptureState, 'captured')
})
await check('capture failure retains delivered receipt and retries only exact original capture without another send', async () => {
  const h = harness({ captureFailures: 1 })
  await assert.rejects(h.run(), error => /Email delivered; CRM source capture pending/.test(error.message) && !/Private provider/.test(error.message))
  const first = h.durable()
  assert.equal(first.externalId, providerMessage)
  assert.equal(first.responseSummary.deliveryState, 'delivered')
  assert.equal(first.responseSummary.sourceCaptureState, 'pending')
  assert.equal(h.stages[0].fields.metadata.canonicalSourceId, undefined)
  assert.equal(h.completions.length, 0)
  await h.run()
  assert.equal(h.sends.length, 1)
  assert.equal(h.selections.length, 1)
  assert.equal(h.bindingReads.length, 1)
  assert.equal(h.captures.length, 2)
  assert.deepEqual(h.captures[1], h.captures[0])
  assert.equal(h.stages[1].fields.occurredAt, h.stages[0].fields.occurredAt, 'Successful delivery time is immutable across capture retry')
  assert.equal(h.stages[1].sourceKey, h.stages[0].sourceKey)
})
await check('reselection after delivery cannot switch a capture retry to the newly selected mailbox', async () => {
  const h = harness({ captureFailures: 1 })
  await assert.rejects(h.run(), /Email delivered/)
  h.reselect('different-current-connection')
  await assert.rejects(h.run(), /Email delivered; CRM source capture pending/)
  assert.equal(h.sends.length, 1)
  assert.equal(h.selections.length, 1)
  assert.ok(h.captures.every(input => input.connectionId === originalConnection))
  assert.equal(h.durable().responseSummary.gmailSourceSnapshot.connectionId, originalConnection)
})
await check('new sends without a stable verified account preserve unknown provenance and never adopt it later', async () => {
  for (const options of [{ identity: null }, { bindingFailure: true }]) {
    const h = harness(options); await h.run()
    const originalTime = h.durable().responseSummary.deliverySentAt
    assert.equal(h.durable().responseSummary.gmailSourceSnapshot.mailboxIdentity, null)
    assert.equal(h.durable().responseSummary.sourceCaptureState, 'held-unknown')
    assert.equal(h.captures.length, 0)
    h.verifyLater(); await h.run()
    assert.equal(h.sends.length, 1)
    assert.equal(h.bindingReads.length, 1)
    assert.equal(h.captures.length, 0)
    assert.equal(h.stages[1].fields.occurredAt, originalTime)
  }
})
await check('legacy successful sends without original snapshot/time are neither re-sent nor re-staged', async () => {
  const h = harness({ externalId: providerMessage, responseSummary: { threadId: providerThread, senderEmail: sender } })
  await h.run()
  assert.equal(h.sends.length + h.selections.length + h.bindingReads.length + h.captures.length + h.stages.length, 0)
  assert.equal(h.durable().responseSummary.sourceCaptureState, 'held-unknown')
  assert.equal(h.durable().responseSummary.deliverySentAt, null)
  assert.equal(h.completions.length, 1)
})
await check('invalid recorded identity proof cannot be repaired from current account selection', async () => {
  for (const mailboxIdentity of [{ ...verifiedIdentity, providerAccountId: '' },
    { ...verifiedIdentity, verifiedConnectionId: 'unrecorded-connection' },
    { ...verifiedIdentity, accountEmail: 'different@example.test' }]) {
    const h = harness({ externalId: providerMessage, responseSummary: { deliverySentAt: '2026-10-28T09:00:00.123Z',
      gmailSourceSnapshot: { version: 1, credentialOwnerEmail: owner, connectionId: originalConnection,
        accountEmail: mailbox, capturedAt: '2026-10-28T09:00:00.123Z', mailboxIdentity } } })
    await h.run()
    assert.equal(h.sends.length + h.bindingReads.length + h.captures.length + h.stages.length, 0)
    assert.equal(h.durable().responseSummary.sourceCaptureState, 'held-unknown')
  }
})
await check('CRM staging failure after successful capture still cannot trigger a duplicate send', async () => {
  const h = harness({ stageFailures: 1 })
  await assert.rejects(h.run(), /Synthetic stage failure/)
  const sentAt = h.durable().responseSummary.deliverySentAt
  await h.run()
  assert.equal(h.sends.length, 1)
  assert.equal(h.bindingReads.length, 1)
  assert.equal(h.stages[1].fields.occurredAt, sentAt)
  assert.equal(h.stages[1].fields.metadata.canonicalSourceId, canonicalSourceId)
})
console.log(`${passed} outbound canonical-source checks passed; synthetic provider/persistence only`)
