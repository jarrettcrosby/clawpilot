#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPipelineOutboxPoll } from './lib/pipeline-outbox-poll.mjs'

// Synthetic responses only: no process environment, hosted endpoints, or secrets.
const baseUrl = 'https://synthetic-worker.example.test'
const secret = 'synthetic-worker-secret'
const endpoint = '/synthetic/crm/process'
const sensitive = 'synthetic-sensitive-value@example.test'
let passed = 0

function harness({ payload = {}, status = 200, failure, text } = {}) {
  const requests = [], logs = [], warnings = []
  const poll = createPipelineOutboxPoll({
    baseUrl, secret,
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      if (failure) throw failure
      return new Response(text === undefined ? JSON.stringify(payload) : text, { status })
    },
    logger: { log: message => logs.push(message), warn: message => warnings.push(message) },
  })
  return { poll, requests, logs, warnings }
}

function jsonAfter(message, prefix) {
  assert.ok(message.startsWith(prefix))
  return JSON.parse(message.slice(prefix.length))
}

function assertNumericOnly(value) {
  for (const entry of Object.values(value)) {
    if (entry && typeof entry === 'object') assertNumericOnly(entry)
    else {
      assert.equal(typeof entry, 'number')
      assert.ok(Number.isFinite(entry) && Number.isInteger(entry) && entry >= 0 && entry <= 1_000_000)
    }
  }
}

function assertNoSensitiveOutput(test) {
  const output = JSON.stringify([...test.logs, ...test.warnings])
  for (const fragment of [secret, sensitive, baseUrl, endpoint]) assert.ok(!output.includes(fragment))
}

async function check(name, run) {
  await run()
  passed += 1
  console.log(`PASS ${name}`)
}

await check('actual poll retains the POST request contract and stays quiet while idle', async () => {
  const test = harness({ payload: { ok: true, actions: { claimed: 0 }, ingestion: { errors: 0, messagesStored: 0 } } })
  assert.equal(await test.poll('crm-integrations', endpoint, 10), true)
  assert.equal(test.requests.length, 1)
  assert.deepEqual(test.requests[0], {
    url: `${baseUrl}${endpoint}`,
    init: { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: '{"limit":10}' },
  })
  assert.deepEqual(test.logs, [])
  assert.deepEqual(test.warnings, [])
})

await check('HTTP-successful ingestion errors warn even without claimed or stored work', async () => {
  const test = harness({ payload: {
    ok: true, error: sensitive, endpoint, secret,
    actions: { claimed: 0 },
    ingestion: { activeMailboxes: 2, mailboxesPolled: 1, messagesStored: 0, errors: 1, lastError: sensitive },
  } })
  assert.equal(await test.poll('crm-integrations', endpoint, 10), true, 'Partial errors must not change the successful HTTP/backoff contract')
  assert.equal(test.warnings.length, 1)
  assert.deepEqual(test.logs, [])
  const summary = jsonAfter(test.warnings[0], '[crm-integrations] ingestion errors: ')
  assert.equal(summary.ingestion.errors, 1)
  assert.equal(summary.ingestion.activeMailboxes, 2)
  assert.equal(summary.ingestion.mailboxesPolled, 1)
  assertNumericOnly(summary)
  assertNoSensitiveOutput(test)
})

await check('partial errors with successful work cannot trigger raw response logging', async () => {
  const test = harness({ payload: {
    ok: true, secret, endpoint, error: sensitive,
    actions: { claimed: 2, failed: 1, lastError: sensitive },
    ingestion: { messagesStored: 4, errors: 1, lastError: sensitive },
  } })
  assert.equal(await test.poll('crm-integrations', endpoint, 10), true)
  assert.equal(test.warnings.length, 1)
  assert.equal(test.logs.length, 0)
  const summary = jsonAfter(test.warnings[0], '[crm-integrations] ingestion errors: ')
  assert.equal(summary.actions.claimed, 2)
  assert.equal(summary.ingestion.messagesStored, 4)
  assertNumericOnly(summary)
  assertNoSensitiveOutput(test)
})

await check('CRM activity still logs, but only the reviewed numeric counters', async () => {
  const test = harness({ payload: {
    actions: { claimed: 1, processed: 1, succeeded: 1, hidden: sensitive },
    ingestion: { messagesStored: 3, messagesFetched: 5, errors: 0, lastError: sensitive },
    endpoint, secret,
  } })
  assert.equal(await test.poll('crm-integrations', endpoint, 10), true)
  assert.deepEqual(test.warnings, [])
  const summary = jsonAfter(test.logs[0], '[crm-integrations] ')
  assert.equal(summary.actions.claimed, 1)
  assert.equal(summary.ingestion.messagesStored, 3)
  assertNumericOnly(summary)
  assertNoSensitiveOutput(test)
})

await check('untrusted counters are not coerced, negative, fractional, or unbounded', async () => {
  const test = harness({ payload: {
    actions: { claimed: true, processed: '12', succeeded: -1, failed: 1.5, dead: null },
    ingestion: { errors: 1e30, messagesStored: '5', mailboxesPolled: -9, messagesFetched: 2.5, activeMailboxes: {} },
  } })
  assert.equal(await test.poll('crm-integrations', endpoint, 10), true)
  const summary = jsonAfter(test.warnings[0], '[crm-integrations] ingestion errors: ')
  assert.equal(summary.ingestion.errors, 1_000_000)
  assert.equal(summary.ingestion.messagesStored, 0)
  assert.equal(summary.ingestion.messagesFetched, 0)
  assert.ok(Object.values(summary.actions).every(value => value === 0))
  assertNumericOnly(summary)
})

await check('string errors cannot inject log output or create a false warning', async () => {
  const test = harness({ payload: { ingestion: { errors: `1 ${sensitive}`, messagesStored: 0 } } })
  assert.equal(await test.poll('crm-integrations', endpoint, 10), true)
  assert.deepEqual(test.logs, [])
  assert.deepEqual(test.warnings, [])
})

await check('JSON numeric overflow is rejected rather than logged as a non-finite counter', async () => {
  const test = harness({ text: '{"actions":{"claimed":1e999},"ingestion":{"errors":1,"messagesFetched":-1e999}}' })
  assert.equal(await test.poll('crm-integrations', endpoint, 10), true)
  const summary = jsonAfter(test.warnings[0], '[crm-integrations] ingestion errors: ')
  assert.equal(summary.actions.claimed, 0)
  assert.equal(summary.ingestion.messagesFetched, 0)
  assertNumericOnly(summary)
})

await check('CRM HTTP failure logs only numeric status and retains failed poll return', async () => {
  const test = harness({ status: 403, text: `${sensitive} ${secret} ${baseUrl}${endpoint}` })
  assert.equal(await test.poll('crm-integrations', endpoint, 10), false)
  assert.deepEqual(jsonAfter(test.warnings[0], '[crm-integrations] poll failed: '), { status: 403 })
  assertNoSensitiveOutput(test)
})

await check('CRM network and malformed JSON failures never expose thrown error text', async () => {
  for (const input of [{ failure: new Error(`${sensitive} ${secret} ${baseUrl}${endpoint}`) }, { text: sensitive }]) {
    const test = harness(input)
    assert.equal(await test.poll('crm-integrations', endpoint, 10), false)
    const summary = jsonAfter(test.warnings[0], '[crm-integrations] poll failed: ')
    assert.equal(summary.status, input.failure ? 0 : 200)
    assertNumericOnly(summary)
    assertNoSensitiveOutput(test)
  }
})

await check('non-CRM activity and failure behavior remains unchanged', async () => {
  const payload = { claimed: 2, ingested: 1, fixture: 'unchanged' }
  const active = harness({ payload })
  assert.equal(await active.poll('pipeline-outbox', '/synthetic/outbox', 10), true)
  assert.deepEqual(active.logs, [`[pipeline-outbox] ${JSON.stringify(payload)}`])
  assert.deepEqual(active.warnings, [])
  const failed = harness({ status: 503, text: 'synthetic upstream failure' })
  assert.equal(await failed.poll('pipeline-outbox', '/synthetic/outbox', 10), false)
  assert.deepEqual(failed.warnings, ['[pipeline-outbox] poll failed: HTTP 503: synthetic upstream failure'])
})

const poller = readFileSync(new URL('./pipeline-outbox-poller.mjs', import.meta.url), 'utf8')
assert.match(poller, /import \{ createPipelineOutboxPoll \} from '\.\/lib\/pipeline-outbox-poll\.mjs'/)
assert.match(poller, /const poll = createPipelineOutboxPoll\(\{ baseUrl, secret \}\)/)
assert.match(poller, /const succeeded = await poll\(name, path, limit\)/)
assert.match(poller, /runLoop\('crm-integrations', '\/api\/crm\/integrations\/process', 10, crmIntegrationIntervalMs\)/)
console.log(`Pipeline outbox polling passed: ${passed} synthetic checks; no live requests`)
