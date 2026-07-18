#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8')

function transpile(path) {
  return ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
}

function loadWorkItemModule() {
  const path = 'app_src/lib/workItemModel.ts'
  const module = { exports: {} }
  const sandbox = {
    console,
    exports: module.exports,
    module,
    require(specifier) {
      if (specifier !== '@/lib/crm/boardCard.mjs') throw new Error(`Unexpected import: ${specifier}`)
      return {
        isCrmBoardCard: () => false,
        normalizeCrmBoardCard: (task) => task,
      }
    },
  }
  vm.runInNewContext(transpile(path), sandbox, { filename: path })
  return module.exports
}

function loadExecutionModule(workItem) {
  const path = 'app_src/lib/agents/taskExecution.ts'
  const module = { exports: {} }
  const sandbox = {
    console,
    exports: module.exports,
    module,
    require(specifier) {
      if (specifier !== '@/lib/workItemModel') throw new Error(`Unexpected import: ${specifier}`)
      return workItem
    },
  }
  vm.runInNewContext(transpile(path), sandbox, { filename: path })
  return module.exports
}

function loadTaskDocumentModule() {
  const path = 'app_src/lib/agents/taskDocument.ts'
  const module = { exports: {} }
  const sandbox = {
    console,
    exports: module.exports,
    module,
    require(specifier) {
      throw new Error(`Unexpected import: ${specifier}`)
    },
  }
  vm.runInNewContext(transpile(path), sandbox, { filename: path })
  return module.exports
}

function loadAgentDispatchModule() {
  const path = 'app_src/lib/agents/dispatch.ts'
  const module = { exports: {} }
  const sandbox = {
    console,
    exports: module.exports,
    module,
    require(specifier) {
      if (specifier === 'crypto') return requireFromApp('node:crypto')
      throw new Error(`Unexpected import: ${specifier}`)
    },
  }
  vm.runInNewContext(transpile(path), sandbox, { filename: path })
  return module.exports
}

function loadAgentDispatchPersistenceModule() {
  const path = 'app_src/lib/persistence/agentDispatch.ts'
  const module = { exports: {} }
  const sandbox = {
    console,
    exports: module.exports,
    module,
    require(specifier) {
      if (specifier === 'crypto') return requireFromApp('node:crypto')
      if (specifier === '@/lib/persistence/postgres') {
        return {
          query: async () => ({ rows: [], rowCount: 0 }),
          withTransaction: async (callback) => callback({ query: async () => ({ rows: [], rowCount: 0 }) }),
        }
      }
      throw new Error(`Unexpected import: ${specifier}`)
    },
  }
  vm.runInNewContext(transpile(path), sandbox, { filename: path })
  return module.exports
}

function mockResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  }
}

function loadDispatchWorker({ failBeforeResult = false, failSucceededState = false } = {}) {
  const path = 'app_src/lib/agentDispatchWorker.ts'
  const module = { exports: {} }
  const taskStates = []
  const failedItems = []
  const item = {
    dispatchId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'agent:board:task:assignment:event',
    operatorId: 'owner@example.com',
    boardId: '22222222-2222-4222-8222-222222222222',
    taskId: 'task-1',
    agentId: 'projects',
    text: 'Execute the task.',
    trigger: 'assignment',
    queuedAt: '2026-07-16T12:00:00.000Z',
    attempts: 1,
    lockToken: 'lock-1',
  }
  const persistence = {
    claimAgentDispatchOutboxInPostgres: async () => [item],
    completeAgentDispatchOutboxInPostgres: async () => undefined,
    failAgentDispatchOutboxInPostgres: async (input) => {
      failedItems.push(input)
      return 'failed'
    },
  }
  const fetch = async (url, init) => {
    const body = JSON.parse(String(init.body || '{}'))
    if (String(url).endsWith('/api/tasks')) {
      const status = String(body?._agentDispatchState?.status || '')
      taskStates.push(status)
      if (failSucceededState && status === 'succeeded') {
        return mockResponse(500, { error: 'task state write failed' })
      }
      return mockResponse(200, { ok: true })
    }
    if (String(url).endsWith('/api/agents/threads')) {
      return failBeforeResult
        ? mockResponse(502, { error: 'provider failed' })
        : mockResponse(200, { ok: true })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }
  const sandbox = {
    AbortController,
    clearTimeout,
    console,
    exports: module.exports,
    fetch,
    module,
    process: { env: { PORT: '4002', PIPELINE_OUTBOX_WORKER_SECRET: 'test-secret' } },
    require(specifier) {
      if (specifier !== '@/lib/persistence/agentDispatch') throw new Error(`Unexpected import: ${specifier}`)
      return persistence
    },
    setTimeout,
  }
  vm.runInNewContext(transpile(path), sandbox, { filename: path })
  return { worker: module.exports, taskStates, failedItems }
}

const workItem = loadWorkItemModule()
const execution = loadExecutionModule(workItem)
const taskDocument = loadTaskDocumentModule()
const agentDispatch = loadAgentDispatchModule()
const agentDispatchPersistence = loadAgentDispatchPersistenceModule()
assert.equal(agentDispatch.commentTargetsAssignedAgent('@Projects please research this.', 'projects'), true)
assert.equal(agentDispatch.commentTargetsAssignedAgent('Question for (@Projects): what changed?', 'projects'), true)
assert.equal(agentDispatch.commentTargetsAssignedAgent('@projects-extra should not route.', 'projects'), false)
assert.equal(agentDispatch.commentTargetsAssignedAgent('@ProjectsExtra should not route.', 'projects'), false)
const plan = execution.parseAgentTaskExecutionPlan(JSON.stringify({
  status: 'triaged',
  summary: 'Converted the request into durable task context and acceptance steps.',
  nextAction: 'Implement the first unchecked acceptance step.',
  waitingOn: '',
  blocker: '',
  descriptionUpdate: 'Preserved implementation scope supplied by the operator.',
  checklistAdd: ['Implement the workflow', 'Verify the live workflow', 'Implement the workflow'],
  learned: 'Persist evidence before reporting progress.',
}))
assert.equal(plan.status, 'triaged')
assert.equal(plan.checklistAdd.length, 2)

assert.throws(
  () => execution.parseAgentTaskExecutionPlan(JSON.stringify({
    status: 'blocked', summary: 'Cannot execute.', nextAction: 'Connect a runner.',
  })),
  /specific blocker/,
)

const baseTask = {
  id: 'task-1',
  title: 'Implement integration',
  desc: 'Task created from directive. See checklist/comments for execution details.',
  status: 'backlog',
  priority: 'high',
  category: 'clawpilot',
  tags: [],
  assignedAgent: 'projects',
  createdAt: '2026-07-16T12:00:00.000Z',
  updatedAt: '2026-07-16T12:00:00.000Z',
  activity: [],
  comments: [],
  checklist: [],
  execution: {
    executionStatus: 'running',
    agentDispatch: {
      id: 'dispatch-1',
      trigger: 'assignment',
      status: 'running',
      attempts: 1,
      queuedAt: '2026-07-16T12:00:00.000Z',
      updatedAt: '2026-07-16T12:00:00.000Z',
    },
  },
}

const manualPrepared = agentDispatch.prepareAgentDispatch({
  operatorId: 'owner@example.com',
  boardId: '22222222-2222-4222-8222-222222222222',
  task: { ...baseTask, execution: undefined },
  agentId: 'projects',
  text: 'Produce the requested task deliverable.',
  trigger: 'manual',
  eventId: 'manual-request-1',
  queuedAt: '2026-07-16T12:00:30.000Z',
})
assert.equal(manualPrepared.dispatch.trigger, 'manual')
assert.equal(
  manualPrepared.dispatch.idempotencyKey,
  'agent:22222222-2222-4222-8222-222222222222:task-1:manual:manual-request-1',
)
assert.equal(manualPrepared.task.execution.agentDispatch.trigger, 'manual')
assert.equal(manualPrepared.task.execution.latestExecutionNote, 'Agent run queued from manual work request.')
assert.equal(manualPrepared.task.activity.at(-1).message, 'Agent projects run queued from manual work request.')

const dispatchQueries = []
const dispatchClient = {
  async query(statement, parameters = []) {
    const sql = String(statement)
    dispatchQueries.push({ sql, parameters })
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
    if (sql.includes('SELECT id::text') && sql.includes('FROM sync_outbox')) return { rows: [], rowCount: 0 }
    if (sql.includes('INSERT INTO sync_outbox')) {
      return { rows: [{ id: manualPrepared.dispatch.dispatchId, status: 'queued' }], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO audit_events')) return { rows: [], rowCount: 1 }
    throw new Error(`Unexpected dispatch SQL: ${sql}`)
  },
}
const insertedManual = await agentDispatchPersistence.insertAgentDispatchOutbox(
  dispatchClient,
  manualPrepared.dispatch,
)
assert.equal(insertedManual.status, 'queued', 'manual must be a valid durable dispatch trigger')
assert.ok(
  dispatchQueries.some((entry) => entry.sql.includes('pg_advisory_xact_lock')),
  'manual dispatch insertion must serialize overlap checks per task',
)

const conflictingDispatchClient = {
  async query(statement) {
    const sql = String(statement)
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
    if (sql.includes('SELECT id::text') && sql.includes('FROM sync_outbox')) {
      return { rows: [{ id: '33333333-3333-4333-8333-333333333333' }], rowCount: 1 }
    }
    throw new Error(`Conflict check should stop before dispatch insertion: ${sql}`)
  },
}
await assert.rejects(
  () => agentDispatchPersistence.insertAgentDispatchOutbox(conflictingDispatchClient, manualPrepared.dispatch),
  (error) => agentDispatchPersistence.isAgentDispatchConflictError(error)
    && /already queued or running/.test(error.message),
  'a second manual run must be rejected inside the dispatch transaction',
)

const first = execution.applyAgentTaskExecutionPlan({
  task: baseTask,
  plan,
  agentId: 'projects',
  dispatchId: 'dispatch-1',
  timestamp: '2026-07-16T12:01:00.000Z',
})
assert.equal(first.task.desc, plan.descriptionUpdate)
assert.equal(first.task.checklist.length, 2)
assert.equal(first.task.status, 'todo')
assert.equal(first.task.execution.executionStatus, 'triaged')
assert.notEqual(first.task.execution.executionStatus, 'completed')
assert.deepEqual(Array.from(first.task.execution.lastResult.evidence), [
  'description updated',
  '2 checklist items added',
  'card moved to todo',
  'next action updated',
])

const retried = execution.applyAgentTaskExecutionPlan({
  task: first.task,
  plan,
  agentId: 'projects',
  dispatchId: 'dispatch-1',
  timestamp: '2026-07-16T12:02:00.000Z',
})
assert.equal(retried.task.checklist.length, 2, 'dispatch retry must not duplicate checklist entries')

const iterativePlan = execution.parseAgentTaskExecutionPlan(JSON.stringify({
  status: 'running',
  summary: 'Produced the system-of-record decision table.',
  deliverable: 'QuickBooks owns posted accounting records. ClawPilot owns workflow state and records external accounting IDs.',
  nextAction: 'Define the tenant-scoped external ID and synchronization journal schema.',
  waitingOn: '',
  blocker: '',
  descriptionUpdate: '',
  checklistAdd: [],
  checklistComplete: ['ck-run-1'],
  learned: 'Complete only checklist work supported by a persisted deliverable.',
}))
const iterativeResult = execution.applyAgentTaskExecutionPlan({
  task: {
    ...baseTask,
    desc: 'Research and design the accounting integration.',
    checklist: [
      { id: 'ck-run-1', text: 'Define system-of-record rules', done: false },
      { id: 'ck-run-2', text: 'Design the synchronization journal', done: false },
    ],
  },
  plan: iterativePlan,
  agentId: 'projects',
  dispatchId: 'dispatch-1',
  timestamp: '2026-07-16T12:02:05.000Z',
})
assert.equal(iterativeResult.task.checklist[0].done, true)
assert.equal(iterativeResult.task.checklist[1].done, false)
assert.equal(iterativeResult.task.status, 'in-progress')
assert.equal(iterativeResult.task.execution.executionStatus, 'running')
assert.equal(iterativeResult.task.execution.lastResult.deliverable, iterativePlan.deliverable)
assert.deepEqual(Array.from(iterativeResult.task.execution.lastResult.completedChecklistIds), ['ck-run-1'])

const checklistTextResult = execution.applyAgentTaskExecutionPlan({
  task: {
    ...baseTask,
    checklist: [{ id: 'ck-run-2', text: 'Design the synchronization journal', done: false }],
  },
  plan: execution.parseAgentTaskExecutionPlan(JSON.stringify({
    status: 'running',
    summary: 'Designed the synchronization journal.',
    deliverable: 'The journal records tenant, realm, entity, direction, cursor, attempt, and terminal state.',
    nextAction: 'Review the persisted design.',
    waitingOn: '',
    blocker: '',
    descriptionUpdate: '',
    checklistAdd: [],
    checklistComplete: ['Design the synchronization journal'],
    learned: 'Resolve an exact checklist label without completing adjacent work.',
  })),
  agentId: 'projects',
  dispatchId: 'dispatch-1',
  timestamp: '2026-07-16T12:02:10.000Z',
})
assert.equal(checklistTextResult.task.checklist[0].done, true, 'an exact checklist label should resolve to its stable ID')

const firstDocument = taskDocument.buildAgentTaskDocument({
  taskId: 'task-1',
  taskTitle: 'QuickBooks Integration',
  boardId: 'board-1',
  agentId: 'projects',
  resultId: 'dispatch-1',
  status: 'running',
  summary: 'Defined the system-of-record contract.',
  deliverable: 'QuickBooks owns posted accounting records.',
  changes: ['checklist completed: "Define system-of-record rules"'],
  nextAction: 'Design the synchronization journal.',
  waitingOn: '',
  recordedAt: '2026-07-16T12:02:10.000Z',
  displayTimestamp: 'Jul 16, 2026, 8:02 AM',
})
assert.equal(firstDocument.title, 'QuickBooks Integration - Projects Research')
assert.equal(firstDocument.appended, true)
assert.match(firstDocument.content, /QuickBooks owns posted accounting records/)
assert.match(firstDocument.content, /## Working deliverable/)
const duplicateDocument = taskDocument.buildAgentTaskDocument({
  existingContent: firstDocument.content,
  taskId: 'task-1',
  taskTitle: 'QuickBooks Integration',
  boardId: 'board-1',
  agentId: 'projects',
  resultId: 'dispatch-1',
  status: 'running',
  summary: 'Defined the system-of-record contract.',
  deliverable: 'QuickBooks owns posted accounting records.',
  changes: [],
  nextAction: 'Design the synchronization journal.',
  waitingOn: '',
  recordedAt: '2026-07-16T12:02:10.000Z',
  displayTimestamp: 'Jul 16, 2026, 8:02 AM',
})
assert.equal(duplicateDocument.appended, false, 'dispatch retries must not duplicate document work-log entries')
assert.equal(duplicateDocument.content, firstDocument.content)
const continuedDocument = taskDocument.buildAgentTaskDocument({
  existingContent: firstDocument.content,
  taskId: 'task-1',
  taskTitle: 'QuickBooks Integration',
  boardId: 'board-1',
  agentId: 'projects',
  resultId: 'dispatch-2',
  status: 'running',
  summary: 'Designed the synchronization journal.',
  deliverable: 'The journal records each replay-safe synchronization attempt.',
  changes: ['checklist completed: "Design the synchronization journal"'],
  nextAction: 'Define conflict handling.',
  waitingOn: '',
  recordedAt: '2026-07-16T12:04:10.000Z',
  displayTimestamp: 'Jul 16, 2026, 8:04 AM',
})
assert.match(continuedDocument.content, /agent-result:dispatch-2/)
assert.match(continuedDocument.content, /agent-result:dispatch-1/)
assert.ok(continuedDocument.content.indexOf('agent-result:dispatch-2') < continuedDocument.content.indexOf('agent-result:dispatch-1'))
assert.doesNotMatch(
  continuedDocument.content,
  /QuickBooks owns posted accounting records/,
  'the coherent working document must replace prior deliverable bodies while retaining compact audit markers',
)

const overlappingPlan = execution.parseAgentTaskExecutionPlan(JSON.stringify({
  status: 'triaged',
  summary: 'Refined the accepted architecture without creating duplicate work.',
  nextAction: 'Create the first implementation task.',
  waitingOn: '',
  blocker: '',
  descriptionUpdate: '',
  checklistAdd: [
    'Document hybrid architecture and system-of-record rules for accounting vs workflow entities',
    'Define workspace-to-realm tenant binding and external ID mapping schema',
    'Specify inbox/outbox, idempotency, retry, and sync journal requirements',
    'Add phased milestones and acceptance criteria for read sync, sandbox writes, bidirectional sync, and receipts',
    'Require sandbox validation and explicit operator approval before enabling production QuickBooks writes',
    'Define reviewed receipt posting gate with extraction, approval, attachment, and audit requirements',
  ],
  learned: 'Keep repeated planning passes idempotent.',
}))
const overlappingChecklistTask = {
  ...baseTask,
  desc: 'Detailed QuickBooks integration context.',
  checklist: [
    { id: 'ck-1', text: 'Define system-of-record rules for Customers, Items, Invoices, and receipt workflows', done: false },
    { id: 'ck-2', text: 'Design tenant-scoped external ID mapping, sync journal, inbox/outbox, and idempotency keys', done: false },
    { id: 'ck-3', text: 'Sequence implementation phases from read-sync MVP through bidirectional invoices', done: false },
    { id: 'ck-4', text: 'Define reviewed receipt-posting workflow with extraction, approval, and attachment handling', done: false },
  ],
}
const overlappingResult = execution.applyAgentTaskExecutionPlan({
  task: overlappingChecklistTask,
  plan: overlappingPlan,
  agentId: 'projects',
  dispatchId: 'dispatch-2',
  timestamp: '2026-07-16T12:02:15.000Z',
})
assert.equal(overlappingResult.task.checklist.length, 5, 'semantically overlapping checklist entries must be skipped')
assert.equal(
  overlappingResult.task.checklist.at(-1).text,
  'Require sandbox validation and explicit operator approval before enabling production QuickBooks writes',
  'a distinct release gate should remain actionable',
)

const substantiveDescription = [
  'Preserve this operator-authored implementation brief exactly, including punctuation and line breaks.',
  '',
  'Acceptance criteria:',
  '- Keep tenant boundaries explicit for every read and write.',
  '- Preserve retry idempotency after partial persistence.',
  '- Record evidence without claiming work that did not occur.',
  '',
  'This context is intentionally longer than a compact generated summary so dispatch cannot replace it.',
].join('\n')
const preservedDescription = execution.applyAgentTaskExecutionPlan({
  task: { ...baseTask, desc: substantiveDescription },
  plan,
  agentId: 'projects',
  dispatchId: 'dispatch-1',
  timestamp: '2026-07-16T12:02:30.000Z',
})
assert.equal(
  preservedDescription.task.desc,
  substantiveDescription,
  'agent descriptionUpdate must not replace a substantive user-authored task description',
)
assert.equal(Buffer.from(preservedDescription.task.desc).equals(Buffer.from(substantiveDescription)), true)

const newerDispatchTask = {
  ...first.task,
  execution: {
    ...first.task.execution,
    executionStatus: 'queued',
    agentDispatch: {
      id: 'dispatch-2',
      trigger: 'comment',
      status: 'queued',
      attempts: 0,
      queuedAt: '2026-07-16T12:03:00.000Z',
      updatedAt: '2026-07-16T12:03:00.000Z',
    },
  },
}
const stale = execution.applyAgentTaskExecutionPlanForDispatch({
  task: newerDispatchTask,
  plan,
  agentId: 'projects',
  dispatchId: 'dispatch-1',
  timestamp: '2026-07-16T12:04:00.000Z',
})
assert.equal(stale.applied, false)
assert.equal(stale.task, newerDispatchTask, 'a stale plan must return the current task unchanged')
assert.deepEqual(Array.from(stale.evidence.changes), [])

const missingDispatch = execution.applyAgentTaskExecutionPlanForDispatch({
  task: { ...baseTask, execution: { executionStatus: 'running' } },
  plan,
  agentId: 'projects',
  dispatchId: 'dispatch-1',
  timestamp: '2026-07-16T12:04:30.000Z',
})
assert.equal(missingDispatch.applied, false, 'a plan without a matching canonical dispatch must be stale')

const awaitingPlan = execution.parseAgentTaskExecutionPlan(JSON.stringify({
  status: 'awaiting_input',
  summary: 'The task needs one operator decision before work can continue.',
  nextAction: 'Provide the target environment.',
  waitingOn: 'the target environment',
  blocker: '',
  descriptionUpdate: '',
  checklistAdd: [],
  learned: 'Record the exact missing input.',
}))
const awaitingResult = execution.applyAgentTaskExecutionPlan({
  task: baseTask,
  plan: awaitingPlan,
  agentId: 'projects',
  dispatchId: 'dispatch-1',
  timestamp: '2026-07-16T12:05:00.000Z',
})
assert.equal(awaitingResult.task.status, 'review')
const overwrittenByRetry = workItem.applyCanonicalWorkItem({
  ...awaitingResult.task,
  execution: {
    ...awaitingResult.task.execution,
    executionStatus: 'running',
    latestExecutionNote: 'Agent run is processing.',
    agentDispatch: {
      ...awaitingResult.task.execution.agentDispatch,
      status: 'running',
      updatedAt: '2026-07-16T12:06:00.000Z',
    },
  },
})
assert.equal(overwrittenByRetry.workItem.waitingOn, undefined, 'the simulated transport overwrite should remove derived waiting state')
const restored = execution.restorePersistedAgentTaskExecutionOutcome({
  task: overwrittenByRetry,
  agentId: 'projects',
  dispatchId: 'dispatch-1',
  timestamp: '2026-07-16T12:07:00.000Z',
})
assert.ok(restored, 'a persisted outcome should be recoverable by dispatch ID')
assert.equal(restored.task.execution.executionStatus, 'awaiting_input')
assert.equal(restored.task.execution.agentDispatch.status, 'succeeded')
assert.equal(restored.task.workItem.waitingOn, 'the target environment')
assert.match(restored.task.execution.latestExecutionNote, /Status: awaiting_input/)

const noEvidencePlan = execution.parseAgentTaskExecutionPlan(JSON.stringify({
  status: 'triaged',
  summary: 'No additional task artifact was required.',
  nextAction: 'Keep the existing next action.',
  waitingOn: '',
  blocker: '',
  descriptionUpdate: '',
  checklistAdd: [],
  learned: 'Do not equate a response with concrete progress.',
}))
const noEvidence = execution.applyAgentTaskExecutionPlan({
  task: {
    ...baseTask,
    status: 'todo',
    desc: 'Detailed implementation context.',
    workItem: {
      status: 'todo',
      assignedAgent: 'projects',
      nextAction: 'Keep the existing next action.',
      activity: [],
    },
  },
  plan: noEvidencePlan,
  agentId: 'projects',
  dispatchId: 'dispatch-1',
  timestamp: '2026-07-16T12:08:00.000Z',
})
assert.deepEqual(Array.from(noEvidence.evidence.changes), [])
assert.equal(noEvidence.task.execution.lastResult.whatWasDone, undefined)
assert.equal(noEvidence.task.workItem.lastConcreteAction, undefined)
assert.equal(workItem.deriveStateTruth({
  workItem: noEvidence.task.workItem,
  checklist: noEvidence.task.checklist,
  executionStatus: noEvidence.task.execution.executionStatus,
  executionUpdatedAt: noEvidence.task.execution.lastUpdatedAt,
  nowMs: Date.parse('2026-07-16T12:09:00.000Z'),
}).stateLabel, 'Waiting')

const postResultFailure = loadDispatchWorker({ failSucceededState: true })
const postResultSummary = await postResultFailure.worker.processAgentDispatchOutbox()
assert.equal(postResultSummary.failed, 1)
assert.deepEqual(postResultFailure.taskStates, ['running', 'succeeded'])
assert.equal(postResultFailure.failedItems.length, 1)

const preResultFailure = loadDispatchWorker({ failBeforeResult: true })
const preResultSummary = await preResultFailure.worker.processAgentDispatchOutbox()
assert.equal(preResultSummary.failed, 1)
assert.deepEqual(preResultFailure.taskStates, ['running', 'queued'])
assert.equal(preResultFailure.failedItems.length, 1)

const taskRoute = read('app_src/app/api/tasks/route.ts')
const agentsSection = read('app_src/components/agents/AgentsSection.tsx')
const cardDetailDrawer = read('app_src/components/projects/CardDetailDrawer.tsx')
const requestUser = read('app_src/lib/requestUser.ts')
assert.match(taskRoute, /return normalized\.slice\(0, 10_000\)/, 'long task descriptions must be preserved')
assert.doesNotMatch(taskRoute, /compact\.length\s*>\s*280/, 'task descriptions must not be replaced at 280 characters')
assert.match(taskRoute, /preservedSuccessStatus/, 'worker success must preserve semantic execution state')
assert.match(taskRoute, /const requestedCommentId = String\(body\._commentId/)
assert.match(taskRoute, /Comment id was already used for different content/)
assert.match(cardDetailDrawer, /const commentSubmittingRef = useRef\(false\)/)
assert.match(cardDetailDrawer, /_commentId: crypto\.randomUUID\(\)/)
assert.match(cardDetailDrawer, /PEOPLE\.filter\(\(person\) => person\.id === task\.assignedAgent\)/)
assert.match(agentsSection, /const sendingRef = useRef\(false\)/)
assert.match(agentsSection, /const messageListRef = useRef<HTMLDivElement \| null>\(null\)/)
assert.match(agentsSection, /messageList\.scrollTop = messageList\.scrollHeight/)
assert.match(agentsSection, /clientMessageId = crypto\.randomUUID\(\)/)
assert.match(agentsSection, /body: JSON\.stringify\(\{ agentId: selectedAgentId, taskId: selectedTaskId, text, mode, clientMessageId \}\)/)
assert.doesNotMatch(
  taskRoute,
  /dispatchStatus === 'succeeded'[\s\S]{0,80}\? 'completed'/,
  'transport success must not imply completed work',
)

const provider = read('app_src/lib/agents/provider.ts')
assert.match(provider, /mode\?: 'conversation' \| 'task-execution'/)
assert.match(provider, /Do not report a planned or suggested action as completed work/)
assert.match(provider, /You cannot edit repository files/)
assert.match(provider, /complete one existing checklist item/)
assert.match(provider, /checklistComplete/)
assert.match(provider, /clean replacement content for the task working document/)

const threadRoute = read('app_src/app/api/agents/threads/route.ts')
const dispatchSource = read('app_src/lib/agents/dispatch.ts')
const dispatchPersistenceSource = read('app_src/lib/persistence/agentDispatch.ts')
assert.match(
  dispatchPersistenceSource,
  /AgentDispatchTrigger = 'assignment' \| 'comment' \| 'continuation' \| 'manual'/,
  'manual work must have a stable durable dispatch trigger',
)
assert.match(
  dispatchPersistenceSource,
  /\['assignment', 'comment', 'continuation', 'manual'\]\.includes\(input\.trigger\)/,
  'dispatch validation must accept the manual trigger',
)
assert.match(dispatchPersistenceSource, /pg_advisory_xact_lock/)
assert.match(dispatchSource, /manual: 'manual work request'/, 'manual queue activity must use a human-readable label')

const postStart = threadRoute.indexOf('export async function POST')
const assignmentGuard = threadRoute.indexOf('const mismatch = assignmentError(task, agentId)', postStart)
const runtimeGuard = threadRoute.indexOf('if (!runtime.ready)', postStart)
const workBranchStart = threadRoute.indexOf("if (signedUserMode === 'work')", postStart)
const synchronousRunStart = threadRoute.indexOf('const runId = dispatchId || clientMessageId || crypto.randomUUID()', workBranchStart)
assert.ok(postStart >= 0 && assignmentGuard > postStart && runtimeGuard > assignmentGuard)
assert.ok(workBranchStart > runtimeGuard && synchronousRunStart > workBranchStart)
const workBranch = threadRoute.slice(workBranchStart, synchronousRunStart)
assert.match(threadRoute, /requestedMode !== 'discuss' && requestedMode !== 'work'/)
assert.match(
  threadRoute,
  /const signedUserMode:[\s\S]{0,120}worker[\s\S]{0,80}\? null[\s\S]{0,120}requestedMode === 'work' \? 'work' : 'discuss'/,
  'missing signed-user mode must default to discuss while worker mode is ignored',
)
assert.match(threadRoute, /const isTaskExecution = Boolean\(worker && dispatchId\)/)
assert.match(threadRoute, /`agent-discuss-\$\{clientMessageId\}-request`/)
assert.match(threadRoute, /`agent-discuss-\$\{clientMessageId\}-result`/)
assert.match(threadRoute, /if \(clientMessageId && existingRequest\)/)
assert.match(threadRoute, /pending: true/)
assert.match(workBranch, /activeDispatch\?\.status === 'queued' \|\| activeDispatch\?\.status === 'running'/)
assert.match(workBranch, /trigger: 'manual'/)
assert.match(workBranch, /await writeTasks\(tasks, board\.id, \[prepared\.dispatch\]\)/)
assert.match(workBranch, /`agent-dispatch-\$\{manualDispatchId\}-request`/)
assert.match(workBranch, /messageId: manualRequestMessageId/)
assert.match(workBranch, /queued: true/)
assert.ok(
  workBranch.indexOf('await writeTasks(tasks, board.id, [prepared.dispatch])')
    < workBranch.indexOf('await upsertPersistedThreadMessage'),
  'the durable task/outbox transaction must commit before the queued response is returned',
)
assert.doesNotMatch(workBranch, /runOpenAIAgent|runChatGPTAgent|runOpenClawAgent|recordAgentResult|captureAgentLearning|writeDocsLog/)
assert.match(threadRoute, /agentDispatches\.length > 0 \|\| isAgentDispatchConflictError\(error\)/)
assert.match(
  threadRoute,
  /const recorded:[\s\S]{0,180}= isTaskExecution\s*\? await recordAgentResult/,
  'discussion must bypass task result recording',
)
assert.match(threadRoute, /if \(isTaskExecution && isPostgresTaskStoreEnabled\(\)\)/)
assert.match(threadRoute, /if \(isTaskExecution\) await writeDocsLog\(agentId, responseText\)/)
assert.match(threadRoute, /interactionMode: isTaskExecution \? 'task-execution' : 'discuss'/)
assert.match(threadRoute, /mode: 'discuss',[\s\S]{0,160}responder: responderId/)
assert.match(threadRoute, /This is a private discussion, not task execution\./)
assert.match(threadRoute, /function publicAgentProviderError/)
assert.match(threadRoute, /The agent connection was rejected\. Reconnect ChatGPT or update the provider credential in Settings\./)
assert.match(threadRoute, /label: runtime\.provider === 'openai-codex' \? 'Reconnect ChatGPT' : 'Provider credential rejected'/)
assert.match(threadRoute, /provider request failed/)
assert.equal(
  (threadRoute.match(/recordAgentResult\(/g) || []).length,
  2,
  'recordAgentResult must have one declaration and one worker-gated call',
)
assert.match(threadRoute, /record\.deliverable \? `Deliverable:/)
assert.match(threadRoute, /boundedContextText\(record\.deliverable, 3_500\)/)
assert.match(threadRoute, /documentReference \? `Document:/)
assert.match(threadRoute, /return boundedContextText\(context, 5_000\)/)
assert.match(threadRoute, /parseAgentTaskExecutionPlan\(responseText\)/)
assert.match(threadRoute, /applyAgentTaskExecutionPlanForDispatch/)
assert.match(threadRoute, /restorePersistedDispatchOutcome/)
assert.match(threadRoute, /evidence:\s*recorded\.evidence\?\.changes/)
assert.match(threadRoute, /trigger:\s*'continuation'/)
assert.match(threadRoute, /continuationDepth < 8/)
assert.match(threadRoute, /const correctiveContinuation = continuationDepth === 0/)
assert.match(threadRoute, /progressedChecklist \|\| correctiveContinuation/)
assert.match(threadRoute, /const comments = shouldQueueContinuation/)
assert.match(threadRoute, /activity: shouldQueueContinuation \|\| activityAlreadyRecorded/)
assert.match(threadRoute, /readAgentTaskDocumentContext/)
assert.match(threadRoute, /Current task working document:/)
assert.match(threadRoute, /Next checklist item ID:/)
assert.match(threadRoute, /appendAgentTaskDocument/)
assert.match(threadRoute, /agentId === 'projects'/)
assert.match(read('scripts/backfill-project-agent-documents.mjs'), /historical-agent-comment:/)
assert.doesNotMatch(threadRoute, /executionStatus:\s*'completed'/)
assert.match(requestUser, /process\.env\.APP_AUTH_REQUIRED !== '0'/)
assert.match(requestUser, /process\.env\.RAILWAY_ENVIRONMENT_NAME/)
assert.match(requestUser, /process\.env\.VERCEL/)
assert.match(requestUser, /local\.developer@example\.test/)
assert.doesNotMatch(requestUser, /developer@clawpilot\.local/)

console.log('agent task execution behavioral tests passed')
