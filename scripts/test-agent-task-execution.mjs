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

function loadExecutionModule() {
  const path = 'app_src/lib/agents/taskExecution.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const sandbox = {
    console,
    exports: module.exports,
    module,
    require(specifier) {
      if (specifier !== '@/lib/workItemModel') throw new Error(`Unexpected import: ${specifier}`)
      return {
        applyCanonicalWorkItem(task) {
          const result = task.execution?.lastResult || {}
          return {
            ...task,
            workItem: {
              status: task.status,
              assignedAgent: task.assignedAgent,
              nextAction: result.nextAction,
              blocker: result.blockedReason,
              waitingOn: result.waitingOn,
              lastConcreteAction: result.whatWasDone,
              activity: task.activity || [],
            },
          }
        },
      }
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const execution = loadExecutionModule()
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
  execution: { executionStatus: 'running' },
}
const first = execution.applyAgentTaskExecutionPlan({
  task: baseTask,
  plan,
  agentId: 'projects',
  dispatchId: 'dispatch-1',
  timestamp: '2026-07-16T12:01:00.000Z',
})
assert.equal(first.task.desc, plan.descriptionUpdate)
assert.equal(first.task.checklist.length, 2)
assert.equal(first.task.execution.executionStatus, 'triaged')
assert.notEqual(first.task.execution.executionStatus, 'completed')
assert.deepEqual(Array.from(first.task.execution.lastResult.evidence), [
  'description updated',
  '2 checklist items added',
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

const taskRoute = read('app_src/app/api/tasks/route.ts')
assert.match(taskRoute, /return normalized\.slice\(0, 10_000\)/, 'long task descriptions must be preserved')
assert.doesNotMatch(taskRoute, /compact\.length\s*>\s*280/, 'task descriptions must not be replaced at 280 characters')
assert.match(taskRoute, /preservedSuccessStatus/, 'worker success must preserve semantic execution state')
assert.doesNotMatch(
  taskRoute,
  /dispatchStatus === 'succeeded'[\s\S]{0,80}\? 'completed'/,
  'transport success must not imply completed work',
)

const provider = read('app_src/lib/agents/provider.ts')
assert.match(provider, /mode\?: 'conversation' \| 'task-execution'/)
assert.match(provider, /Do not report a planned or suggested action as completed work/)
assert.match(provider, /You cannot edit repository files/)

const threadRoute = read('app_src/app/api/agents/threads/route.ts')
assert.match(threadRoute, /parseAgentTaskExecutionPlan\(responseText\)/)
assert.match(threadRoute, /applyAgentTaskExecutionPlan/)
assert.match(threadRoute, /evidence:\s*recorded\.evidence\?\.changes/)
assert.doesNotMatch(threadRoute, /executionStatus:\s*'completed'/)

console.log('agent task execution contract tests passed')
