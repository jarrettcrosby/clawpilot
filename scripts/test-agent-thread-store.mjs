#!/usr/bin/env node
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { readStore, upsertThreadMessage, getThread, writeStoreQueued, updateThreadMeta } from '../app_src/lib/agents/threadStore.mjs'
import { createResponder, resolveResponderId } from '../app_src/lib/agents/responder.mjs'

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-store-test-'))
  const file = path.join(dir, 'threads.json')

  // migration test (legacy model)
  fs.writeFileSync(file, JSON.stringify({
    threads: [{ agentId: 'docs-agent', updatedAt: '2026-01-01T00:00:00Z', messages: [{ text: 'legacy message', timestamp: '2026-01-01T00:00:00Z' }] }],
  }, null, 2))

  const migrated = readStore(file)
  assert.equal(migrated.threads.length, 1)
  assert.equal(migrated.threads[0].threadId, 'thread_docs-agent_general')
  assert.equal(migrated.threads[0].messages.length, 1)
  assert.ok(migrated.threads[0].messages[0].id)
  assert.equal(migrated.threads[0].routing.responder, 'stub')
  assert.ok(migrated.threads[0].context)

  // burst write test
  const burst = []
  for (let i = 0; i < 40; i++) {
    burst.push(upsertThreadMessage({ agentId: 'docs-agent', text: `msg-${i}`, role: 'user' }, file))
  }
  await Promise.all(burst)

  const out = readStore(file)
  const thread = out.threads.find(t => t.agentId === 'docs-agent')
  assert.ok(thread)
  assert.ok(thread.messages.length >= 41) // legacy + 40

  const hasAll = Array.from({ length: 40 }).every((_, i) => thread.messages.some(m => m.text === `msg-${i}`))
  assert.ok(hasAll, 'missing one or more burst messages')
  assert.equal(thread.context.messageCount, thread.messages.length)

  // stale lock recovery test
  const lockFile = `${file}.lock`
  fs.writeFileSync(lockFile, 'stale-lock')
  const staleAt = Date.now() - 30000
  fs.utimesSync(lockFile, staleAt / 1000, staleAt / 1000)
  await upsertThreadMessage({ agentId: 'docs-agent', text: 'post-stale-lock', role: 'user' }, file)

  const outAfterStaleLock = readStore(file)
  const postStale = outAfterStaleLock.threads.find(t => t.agentId === 'docs-agent')
  assert.ok(postStale.messages.some(m => m.text === 'post-stale-lock'))
  assert.ok(!fs.existsSync(lockFile), 'stale lock file should be removed after write')

  // queue recovery test (a failed mutation should not poison later writes)
  await assert.rejects(
    writeStoreQueued(() => {
      throw new Error('intentional queue failure')
    }, file),
    /intentional queue failure/
  )

  await upsertThreadMessage({ agentId: 'docs-agent', text: 'post-queue-failure', role: 'user' }, file)
  const outAfterQueueFailure = readStore(file)
  const postQueueFailure = outAfterQueueFailure.threads.find(t => t.agentId === 'docs-agent')
  assert.ok(postQueueFailure.messages.some(m => m.text === 'post-queue-failure'))

  // routing behavior test
  assert.equal(resolveResponderId('builder-agent'), 'builder')
  assert.equal(resolveResponderId('docs-agent'), 'docs')
  assert.equal(resolveResponderId('unknown-agent'), 'stub')

  const builderResponder = createResponder({ agentId: 'builder-agent' })
  const docsResponder = createResponder({ agentId: 'docs-agent' })
  assert.equal(builderResponder.id, 'builder')
  assert.equal(docsResponder.id, 'docs')

  await upsertThreadMessage({
    agentId: 'builder-agent',
    text: 'implement endpoint',
    role: 'user',
    status: 'resolving',
    routing: { responder: builderResponder.id },
  }, file)

  const thread2 = getThread({ agentId: 'builder-agent' }, file)
  assert.ok(thread2)
  assert.equal(thread2.status, 'resolving')
  assert.equal(thread2.routing.responder, 'builder')
  assert.equal(thread2.context.messageCount, 1)
  assert.equal(thread2.context.lastUserMessageId, thread2.messages[0].id)
  assert.equal(thread2.messages[0].status, 'committed')

  await upsertThreadMessage({
    agentId: 'builder-agent',
    text: 'tool execution started',
    role: 'tool',
    status: 'pending',
    meta: { taskContext: { taskId: 'CP-123', lane: 'dev' } },
  }, file)
  const threadWithPending = getThread({ agentId: 'builder-agent' }, file)
  assert.ok(threadWithPending)
  assert.equal(threadWithPending.messages.at(-1).status, 'pending')
  assert.deepEqual(threadWithPending.contextSnapshot, { taskId: 'CP-123', lane: 'dev' })
  assert.equal(threadWithPending.contextSnapshotUpdatedAt, threadWithPending.messages.at(-1).createdAt)

  // thread meta update behavior (appendTag dedupe + status update)
  await updateThreadMeta({ agentId: 'builder-agent', appendTag: 'overnight' }, file)
  await updateThreadMeta({ agentId: 'builder-agent', appendTag: 'overnight', status: 'active' }, file)
  await updateThreadMeta({ agentId: 'builder-agent', appendTag: '   ' }, file)
  await updateThreadMeta({ agentId: 'builder-agent', tags: [' ops ', '', 'ops', 'nightly'] }, file)
  const thread3 = getThread({ agentId: 'builder-agent' }, file)
  assert.ok(thread3)
  assert.equal(thread3.status, 'active')
  assert.equal(thread3.tags.filter((t) => t === 'overnight').length, 0)
  assert.deepEqual(thread3.tags, ['nightly', 'ops'])

  // invalid status should be ignored to preserve canonical status vocabulary
  await updateThreadMeta({ agentId: 'builder-agent', status: 'in-progress-ish' }, file)
  const thread4 = getThread({ agentId: 'builder-agent' }, file)
  assert.ok(thread4)
  assert.equal(thread4.status, 'active')

  // task-scoped thread isolation behavior
  await upsertThreadMessage({
    agentId: 'builder-agent',
    taskId: 'CP-900',
    text: 'task scoped message',
    role: 'user',
  }, file)
  await updateThreadMeta({ agentId: 'builder-agent', taskId: 'CP-900', appendTag: 'task-tag' }, file)

  const generalThread = getThread({ agentId: 'builder-agent' }, file)
  const taskThread = getThread({ agentId: 'builder-agent', taskId: 'CP-900' }, file)

  assert.ok(generalThread)
  assert.ok(taskThread)
  assert.notEqual(generalThread.threadId, taskThread.threadId)
  assert.equal(taskThread.messages.length, 1)
  assert.equal(taskThread.messages[0].text, 'task scoped message')
  assert.ok(taskThread.tags.includes('task-tag'))
  assert.ok(!generalThread.tags.includes('task-tag'))

  // Dispatch retries replace deterministic messages instead of duplicating them.
  await upsertThreadMessage({
    messageId: 'agent-dispatch-123-result',
    agentId: 'builder-agent',
    taskId: 'CP-900',
    text: 'first attempt failed',
    role: 'system',
    status: 'failed',
    meta: { dispatchId: '123', phase: 'failure' },
  }, file)
  await upsertThreadMessage({
    messageId: 'agent-dispatch-123-result',
    agentId: 'builder-agent',
    taskId: 'CP-900',
    text: 'retry succeeded',
    role: 'agent',
    status: 'committed',
    meta: { dispatchId: '123', phase: 'response' },
  }, file)
  const retriedThread = getThread({ agentId: 'builder-agent', taskId: 'CP-900' }, file)
  const dispatchMessages = retriedThread.messages.filter(message => message.id === 'agent-dispatch-123-result')
  assert.equal(dispatchMessages.length, 1)
  assert.equal(dispatchMessages[0].role, 'agent')
  assert.equal(dispatchMessages[0].text, 'retry succeeded')

  console.log('PASS test-agent-thread-store')
}

run().catch((e) => {
  console.error('FAIL test-agent-thread-store', e)
  process.exit(1)
})
