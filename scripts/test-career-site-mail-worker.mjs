#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const requestId = '0b43bb55-f85e-4492-ab4a-7f22582137e5'
const request = {
  messageType: 'contact-notification',
  idempotencyKey: `contact/${requestId}`,
  data: {
    submissionId: requestId,
    name: 'Worker Test',
    email: 'worker@example.com',
    organization: null,
    interest: 'leadership',
    message: 'Worker recovery test with bounded non-sensitive content.',
  },
}
const configuration = {
  enabled: true,
  sourceApp: 'jarrett-career-site',
  ownerEmail: 'jarrett@suburbiasandwichco.com',
  organizationId: '405bb919-0364-4a88-8a62-b4c9da42cd8f',
  from: 'info@suburbiasandwichco.com',
  fromName: 'Jarrett Crosby',
  replyTo: 'jarrettcrosby@gmail.com',
  approvalTo: 'jarrettcrosby@gmail.com',
  shortLinkOrigin: 'https://eigenracing.com',
  approvalOrigins: ['https://jarrett.suburbiasandwichco.com'],
}

class CareerSiteMailProviderError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'CareerSiteMailProviderError'
    this.status = options.status ?? null
    this.ambiguous = options.ambiguous === true
  }
}

class CareerSiteMailRequestError extends Error {}
class CareerSiteMailConfigurationError extends Error {}

function loadWorker(scenario) {
  const path = 'app_src/lib/careerSiteMailOutbox.ts'
  const output = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const state = {
    claimCount: 0,
    draftId: scenario.initialDraftId || null,
    draftCreationStarted: scenario.initialDraftCreationStarted === true,
    sentCount: 0,
    createCount: 0,
    reserveCount: 0,
    completeCount: 0,
    failCount: 0,
    purgeCount: 0,
    lookupCount: 0,
    draftLookupCount: 0,
  }
  const persistence = {
    async purgeExpiredCareerSiteMailDeadPayloadsInPostgres() {
      state.purgeCount += 1
      return 0
    },
    async claimCareerSiteMailOutboxInPostgres() {
      if (state.claimCount >= scenario.runs) return []
      state.claimCount += 1
      return [{
        id: `00000000-0000-4000-8000-00000000000${state.claimCount}`,
        actor: {
          sourceApp: configuration.sourceApp,
          ownerEmail: configuration.ownerEmail,
          organizationId: configuration.organizationId,
        },
        messageType: request.messageType,
        idempotencyKey: request.idempotencyKey,
        payloadHash: 'a'.repeat(64),
        encryptedPayload: {
          ciphertext: Buffer.from('encrypted'),
          iv: Buffer.alloc(12),
          tag: Buffer.alloc(16),
          keyId: 'test-key',
          encryptionVersion: 1,
        },
        rfcMessageId: 'career-site-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@suburbiasandwichco.com',
        status: 'processing',
        attempts: state.claimCount,
        draftId: state.draftId,
        providerMessageId: null,
        lockToken: `lock-${state.claimCount}`,
      }]
    },
    decryptCareerSiteMailOutboxRequest() {
      return request
    },
    async renewCareerSiteMailOutboxLeaseInPostgres() {},
    async saveCareerSiteMailDraftInPostgres({ draftId }) {
      state.draftCreationStarted = true
      state.draftId = draftId
      return draftId
    },
    async reserveCareerSiteMailDraftCreationInPostgres() {
      if (state.draftCreationStarted) return false
      state.draftCreationStarted = true
      state.reserveCount += 1
      return true
    },
    async completeCareerSiteMailOutboxInPostgres() {
      state.completeCount += 1
      if (scenario.crashAfterSend && state.completeCount === 1) {
        throw new Error('simulated crash after provider send')
      }
    },
    async failCareerSiteMailOutboxInPostgres() {
      state.failCount += 1
      return scenario.failStatuses?.[state.failCount - 1] ?? 'failed'
    },
  }
  const delivery = {
    CareerSiteMailProviderError,
    async verifyCareerSiteMailSender() {},
    async findSentCareerSiteMail() {
      const value = scenario.lookupResults[state.lookupCount] ?? null
      state.lookupCount += 1
      return value
    },
    async findCareerSiteMailDraft() {
      const value = scenario.draftLookupResults?.[state.draftLookupCount] ?? null
      state.draftLookupCount += 1
      return value
    },
    async createCareerSiteMailDraft() {
      state.createCount += 1
      const createError = scenario.createErrors?.[state.createCount - 1] ?? scenario.createError
      if (createError) throw createError
      return { draftId: `draft-${scenario.name}`, draftMessageId: 'draft-message' }
    },
    async sendCareerSiteMailDraft() {
      state.sentCount += 1
      if (scenario.sendError) throw scenario.sendError
      return 'provider-sent-message'
    },
  }
  vm.runInNewContext(output, {
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    String,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === '@/lib/careerSiteMailContract') {
        return {
          CareerSiteMailConfigurationError,
          CareerSiteMailRequestError,
          parseCareerSiteMailRequest: (value) => value,
          resolveCareerSiteMailConfiguration: () => configuration,
        }
      }
      if (specifier === '@/lib/careerSiteMailDelivery') return delivery
      if (specifier === '@/lib/persistence/careerSiteMailOutbox') return persistence
      throw new Error(`Unexpected worker test import: ${specifier}`)
    },
  }, { filename: path })
  return {
    worker: module.exports,
    state,
    operatorRequeue() {
      if (state.draftId === null) state.draftCreationStarted = false
    },
  }
}

async function runScenario(scenario) {
  const loaded = loadWorker(scenario)
  const results = []
  for (let run = 0; run < scenario.runs; run += 1) {
    results.push(await loaded.worker.processCareerSiteMailOutbox())
  }
  return { ...loaded, results }
}

const crash = await runScenario({
  name: 'crash-after-send',
  runs: 2,
  crashAfterSend: true,
  lookupResults: [null, 'sent-recovered-after-crash'],
})
assert.equal(crash.state.sentCount, 1)
assert.equal(crash.state.createCount, 1)
assert.equal(crash.state.failCount, 1)
assert.equal(crash.results[1].succeeded, 1)

const ambiguous = await runScenario({
  name: 'ambiguous-send',
  runs: 2,
  sendError: new CareerSiteMailProviderError('ambiguous send response', { ambiguous: true }),
  lookupResults: [null, null, 'sent-recovered-after-ambiguous-response'],
})
assert.equal(ambiguous.state.sentCount, 1)
assert.equal(ambiguous.state.failCount, 1)
assert.equal(ambiguous.results[1].succeeded, 1)

const missingDraft = await runScenario({
  name: 'draft-404',
  runs: 1,
  initialDraftId: 'durable-draft-404',
  sendError: new CareerSiteMailProviderError('draft was not found', { status: 404 }),
  lookupResults: [null, 'sent-recovered-after-draft-404'],
})
assert.equal(missingDraft.state.sentCount, 1)
assert.equal(missingDraft.state.createCount, 0)
assert.equal(missingDraft.state.failCount, 0)
assert.equal(missingDraft.results[0].items[0].recovered, true)

const sentLookup = await runScenario({
  name: 'sent-lookup',
  runs: 1,
  initialDraftId: 'durable-draft-already-sent',
  lookupResults: ['already-in-sent'],
})
assert.equal(sentLookup.state.sentCount, 0)
assert.equal(sentLookup.state.createCount, 0)
assert.equal(sentLookup.state.completeCount, 1)
assert.equal(sentLookup.results[0].succeeded, 1)

const lostDraftResponse = await runScenario({
  name: 'draft-create-response-loss',
  runs: 1,
  createError: new CareerSiteMailProviderError('draft creation was ambiguous', { ambiguous: true }),
  draftLookupResults: [
    null,
    { draftId: 'draft-recovered-after-response-loss', draftMessageId: 'draft-message-recovered' },
  ],
  lookupResults: [null],
})
assert.equal(lostDraftResponse.state.createCount, 1)
assert.equal(lostDraftResponse.state.reserveCount, 1)
assert.equal(lostDraftResponse.state.draftId, 'draft-recovered-after-response-loss')
assert.equal(lostDraftResponse.state.sentCount, 1)
assert.equal(lostDraftResponse.state.failCount, 0)

const unresolvedDraftResponse = await runScenario({
  name: 'draft-create-unresolved',
  runs: 2,
  createError: new CareerSiteMailProviderError('draft creation was ambiguous', { ambiguous: true }),
  draftLookupResults: [null, null, null],
  lookupResults: [null, null],
})
assert.equal(unresolvedDraftResponse.state.createCount, 1)
assert.equal(unresolvedDraftResponse.state.reserveCount, 1)
assert.equal(unresolvedDraftResponse.state.sentCount, 0)
assert.equal(unresolvedDraftResponse.state.failCount, 2)

const operatorDraftRecovery = loadWorker({
  name: 'operator-authorized-draft-recreation',
  runs: 2,
  failStatuses: ['dead'],
  createErrors: [
    new CareerSiteMailProviderError('draft creation was ambiguous', { ambiguous: true }),
    null,
  ],
  draftLookupResults: [null, null, null],
  lookupResults: [null, null],
})
const firstOperatorAttempt = await operatorDraftRecovery.worker.processCareerSiteMailOutbox({ maxAttempts: 1 })
assert.equal(firstOperatorAttempt.dead, 1)
assert.equal(operatorDraftRecovery.state.createCount, 1)
operatorDraftRecovery.operatorRequeue()
const createCountBeforeOperatorRetry = operatorDraftRecovery.state.createCount
const secondOperatorAttempt = await operatorDraftRecovery.worker.processCareerSiteMailOutbox({ maxAttempts: 1 })
assert.equal(secondOperatorAttempt.succeeded, 1)
assert.equal(operatorDraftRecovery.state.createCount, 2)
assert.equal(operatorDraftRecovery.state.createCount - createCountBeforeOperatorRetry, 1)
assert.equal(operatorDraftRecovery.state.reserveCount, 2)

const lateVisibleDraftRecovery = loadWorker({
  name: 'operator-late-visible-draft-recovery',
  runs: 2,
  failStatuses: ['dead'],
  createError: new CareerSiteMailProviderError('draft creation was ambiguous', { ambiguous: true }),
  draftLookupResults: [
    null,
    null,
    { draftId: 'draft-visible-after-operator-requeue', draftMessageId: 'draft-message-visible-late' },
  ],
  lookupResults: [null, null],
})
const lateVisibleFirstAttempt = await lateVisibleDraftRecovery.worker.processCareerSiteMailOutbox({ maxAttempts: 1 })
assert.equal(lateVisibleFirstAttempt.dead, 1)
assert.equal(lateVisibleDraftRecovery.state.createCount, 1)
lateVisibleDraftRecovery.operatorRequeue()
const lateVisibleSecondAttempt = await lateVisibleDraftRecovery.worker.processCareerSiteMailOutbox({ maxAttempts: 1 })
assert.equal(lateVisibleSecondAttempt.succeeded, 1)
assert.equal(lateVisibleDraftRecovery.state.draftId, 'draft-visible-after-operator-requeue')
assert.equal(lateVisibleDraftRecovery.state.createCount, 1)
assert.equal(lateVisibleDraftRecovery.state.reserveCount, 1)

for (const scenario of [
  crash,
  ambiguous,
  missingDraft,
  sentLookup,
  lostDraftResponse,
  unresolvedDraftResponse,
  { state: operatorDraftRecovery.state, results: [firstOperatorAttempt, secondOperatorAttempt] },
  { state: lateVisibleDraftRecovery.state, results: [lateVisibleFirstAttempt, lateVisibleSecondAttempt] },
]) {
  assert.equal(scenario.state.purgeCount, scenario.results.length)
}

console.log('Career-site mail worker crash and ambiguous-send recovery verified')
