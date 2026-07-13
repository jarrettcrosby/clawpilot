#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

function assertIncludes(source, needle, label) {
  assert.ok(source.includes(needle), `${label} missing ${needle}`)
}

const migration = read('db/migrations/0001_initial_railway_postgres.sql')
for (const table of [
  'execution_runs',
  'execution_results',
  'pipeline_sheet_rows',
  'sync_outbox',
  'audit_events',
]) {
  assertIncludes(migration, `CREATE TABLE IF NOT EXISTS ${table}`, 'initial migration')
}

const outboxMigration = read('db/migrations/0002_pipeline_outbox_worker.sql')
for (const column of ['idempotency_key', 'locked_at', 'lock_token', 'updated_at']) {
  assertIncludes(outboxMigration, column, 'pipeline outbox worker migration')
}

const authMigration = read('db/migrations/0003_auth_magic_codes.sql')
for (const column of ['code_digest', 'attempts', 'expires_at', 'consumed_at']) {
  assertIncludes(authMigration, column, 'auth magic-code migration')
}

const executionAdapter = read('app_src/lib/persistence/execution.ts')
assertIncludes(executionAdapter, 'INSERT INTO execution_runs', 'execution adapter')
assertIncludes(executionAdapter, 'INSERT INTO execution_results', 'execution adapter')
assertIncludes(executionAdapter, "payload->>'runId'", 'execution adapter')
assertIncludes(executionAdapter, 'ORDER BY created_at DESC, id DESC', 'execution adapter')

const pipelineAdapter = read('app_src/lib/persistence/pipeline.ts')
assertIncludes(pipelineAdapter, 'INSERT INTO pipeline_sheet_rows', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'DELETE FROM pipeline_sheet_rows', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'INSERT INTO sync_outbox', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'INSERT INTO audit_events', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'pipeline.normalized.current', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'FOR UPDATE SKIP LOCKED', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'worker lease expired', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'superseded by newer outbox item', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'upsertPipelineDropdownCatalogAndEnqueueInPostgres', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'pipeline.outbox.worker.heartbeat', 'pipeline adapter')

const opportunityRoute = read('app_src/app/api/pipeline/opportunity/[id]/route.ts')
assertIncludes(opportunityRoute, 'enqueuePipelineSyncOutboxInPostgres', 'opportunity route')
assertIncludes(opportunityRoute, 'upsertPipelineProjectionAndEnqueueInPostgres', 'opportunity route')
assertIncludes(opportunityRoute, "operation: 'append_interaction'", 'opportunity route')
assertIncludes(opportunityRoute, "operation: 'update_opportunity'", 'opportunity route')
assertIncludes(opportunityRoute, 'beforeValues', 'opportunity optimistic write contract')

const outboxWorker = read('app_src/lib/pipelineOutboxWorker.ts')
assertIncludes(outboxWorker, 'claimPipelineSyncOutboxInPostgres', 'pipeline outbox worker')
assertIncludes(outboxWorker, "item.operation === 'update_opportunity'", 'pipeline outbox worker')
assertIncludes(outboxWorker, "item.operation === 'append_interaction'", 'pipeline outbox worker')
assertIncludes(outboxWorker, "item.operation === 'replace_dropdowns'", 'pipeline outbox worker')
assertIncludes(outboxWorker, 'Opportunity Sheet row changed', 'pipeline outbox worker optimistic check')
assertIncludes(outboxWorker, '[ClawPilot sync:', 'pipeline outbox worker append idempotency')

const pullRoute = read('app_src/app/api/pipeline/sync/pull/route.ts')
assertIncludes(pullRoute, 'syncPipelineFromSheets', 'pipeline pull route')

const railwayStart = read('scripts/start-railway.sh')
assertIncludes(railwayStart, 'pipeline-outbox-poller.mjs', 'Railway start script')
for (const requiredVariable of [
  'CLAWPILOT_STORAGE',
  'CLAWPILOT_DB_FALLBACK_TO_FILE',
  'CLAWPILOT_EXECUTION_ENABLED',
    'APP_AUTH_REQUIRED',
    'APP_LOGIN_EMAIL',
    'APP_LOGIN_PASSWORD',
    'APP_SESSION_SECRET',
    'DATABASE_URL',
    'MATON_API_KEY',
    'MATON_GMAIL_CONNECTION_ID',
  'PIPELINE_SHEET_ID',
  'PIPELINE_OUTBOX_WORKER_SECRET',
]) {
  assertIncludes(railwayStart, requiredVariable, 'Railway startup validation')
}

const authProxy = read('app_src/proxy.ts')
assertIncludes(authProxy, 'hasValidSession', 'auth proxy')
assertIncludes(authProxy, '_next/static', 'auth proxy matcher')
assertIncludes(authProxy, '/api/pipeline/sync/outbox/process', 'auth proxy public worker route')
assertIncludes(authProxy, 'HOSTED_RUNTIME', 'auth proxy fail-closed hosted mode')

const loginRoute = read('app_src/app/api/auth/login/route.ts')
assertIncludes(loginRoute, 'MAX_ATTEMPTS', 'login rate limit')
assertIncludes(loginRoute, 'timingSafeEqual', 'login password comparison')

const magicRequestRoute = read('app_src/app/api/auth/magic/request/route.ts')
assertIncludes(magicRequestRoute, 'requestAuthMagicCode', 'magic-code request route')
assertIncludes(magicRequestRoute, 'MAX_REQUESTS', 'magic-code request rate limit')

const magicVerifyRoute = read('app_src/app/api/auth/magic/verify/route.ts')
assertIncludes(magicVerifyRoute, 'verifyAuthMagicCode', 'magic-code verify route')
assertIncludes(magicVerifyRoute, 'createSessionToken', 'magic-code session issuance')

const dispatchBridge = read('app_src/lib/dispatchBridge.ts')
assertIncludes(dispatchBridge, 'execution succeeded but completion telemetry could not be persisted', 'dispatch replay guard')

const healthRoute = read('app_src/app/api/health/route.ts')
assertIncludes(healthRoute, 'readPipelineOutboxWorkerHeartbeatFromPostgres', 'hosted worker health')
assertIncludes(healthRoute, '0002_pipeline_outbox_worker.sql', 'hosted migration health')
assertIncludes(healthRoute, '0003_auth_magic_codes.sql', 'hosted auth migration health')
assertIncludes(healthRoute, 'getAgentRuntime', 'hosted agent runtime health')

const agentProvider = read('app_src/lib/agents/provider.ts')
assertIncludes(agentProvider, 'https://api.openai.com/v1/responses', 'OpenAI agent provider')
assertIncludes(agentProvider, 'Execution provider not connected', 'honest agent provider status')

const agentsRoute = read('app_src/app/api/agents/route.ts')
assertIncludes(agentsRoute, "runtime.ready ? 'ready' : 'not connected'", 'agent status route')

const agentThreadsRoute = read('app_src/app/api/agents/threads/route.ts')
assertIncludes(agentThreadsRoute, 'assignmentError(task, agentId)', 'task-bound agent thread contract')
assertIncludes(agentThreadsRoute, 'runOpenAIAgent', 'hosted agent execution route')
assertIncludes(agentThreadsRoute, 'appendExecutionRunToPostgres', 'agent execution run writeback')
assertIncludes(agentThreadsRoute, 'appendExecutionResultToPostgres', 'agent execution result writeback')

const tasksRoute = read('app_src/app/api/tasks/route.ts')
assert.ok(!tasksRoute.includes('buildGovernanceAdvisory'), 'task route must not create governance advisory mutations')
assertIncludes(tasksRoute, 'TASK_NOT_ACTIONABLE', 'explicit active-task validation')

console.log('PASS test-postgres-adapter-contracts')
