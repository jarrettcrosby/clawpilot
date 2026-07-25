#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const migration = read('db/migrations/0109_operations_replenishment_execution.sql')
const types = read('app_src/lib/operations/types.ts')
const persistence = read('app_src/lib/persistence/operations.ts')
const route = read('app_src/app/api/operations/route.ts')
const panel = read('app_src/components/operations/WarehouseSetupPanel.tsx')
const health = read('app_src/app/api/health/route.ts')
const predeploy = read('scripts/verify-predeploy.mjs')

for (const fragment of [
  "('grpl', 'operations.replenishment_task', 'Replenishment task')",
  'CREATE TABLE IF NOT EXISTS operations_replenishment_tasks',
  'recommendation_snapshot jsonb',
  'operations_replenishment_tasks_idempotency_unique',
  "'replenishment_out', 'replenishment_in'",
]) {
  assert.ok(migration.includes(fragment), `Replenishment migration missing ${fragment}`)
}

for (const fragment of [
  'OperationsReplenishmentExecutionInput',
  'OperationsReplenishmentExecutionResult',
  "status: 'completed'",
  'replenishmentTaskGlobalId: string',
]) {
  assert.ok(types.includes(fragment), `Replenishment types missing ${fragment}`)
}

for (const fragment of [
  'executeOperationsReplenishmentInPostgres',
  "commandType: 'execute_replenishment'",
  'completedReplenishmentExecutionResult',
  'acquireTransactionAdvisoryLock',
  'FOR UPDATE OF rule, source, destination, warehouse',
  "event_type,",
  "'replenishment_out'",
  "'replenishment_in'",
  "eventType: 'operations.replenishment.completed'",
  'OPERATIONS_REPLENISHMENT_STALE',
]) {
  assert.ok(persistence.includes(fragment), `Replenishment persistence missing ${fragment}`)
}

for (const fragment of [
  "action === 'execute-replenishment'",
  '!capabilities.canManage || !capabilities.canExecute',
  "idempotencyKey: idempotencyKeyValue(req)",
  'executeOperationsReplenishmentInPostgres',
]) {
  assert.ok(route.includes(fragment), `Replenishment API missing ${fragment}`)
}

for (const fragment of [
  'Confirm replenishment move',
  "action: 'execute-replenishment'",
  "'Idempotency-Key'",
  'Confirm move',
  'Warehouse execution permission is required',
]) {
  assert.ok(panel.includes(fragment), `Replenishment UI missing ${fragment}`)
}

for (const fileText of [health, predeploy]) {
  assert.ok(
    fileText.includes('0109_operations_replenishment_execution.sql'),
    'Migration 0109 must be required by health and predeploy checks',
  )
}

console.log('Operator-confirmed replenishment execution contracts passed.')
