#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function loadMaintenance(query) {
  const path = 'app_src/lib/persistence/commerceStorageMaintenance.ts'
  const output = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    String,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === '@/lib/persistence/postgres') return { query }
      throw new Error(`Unexpected import: ${specifier}`)
    },
  }, { filename: path })
  return module.exports
}

function emptyPurgeRow(sql) {
  if (sql.includes('convert_operations_commerce_inventory_legacy_captures')) {
    return { converted_rows: 0, converted_bytes: '0' }
  }
  return { purged_rows: 0, purged_bytes: '0' }
}

async function runLeaseScenario({ renew = true, complete = true }) {
  const statements = []
  const maintenance = loadMaintenance(async (sql) => {
    statements.push(sql)
    if (sql.includes('schema_migrations')) {
      return { rows: [{ migration_applied: true }] }
    }
    if (sql.includes('claim_operations_commerce_storage_maintenance')) {
      return { rows: [{ lease_token: '11111111-1111-4111-8111-111111111111' }] }
    }
    if (sql.includes('renew_operations_commerce_storage_maintenance')) {
      return { rows: [{ renewed: renew }] }
    }
    if (sql.includes('complete_operations_commerce_storage_maintenance')) {
      return { rows: [{ completed: complete }] }
    }
    return { rows: [emptyPurgeRow(sql)] }
  })
  const result = await maintenance.maintainCommerceStorageInPostgres({
    workerId: 'storage-runtime-test',
  })
  return { result, statements }
}

const completed = await runLeaseScenario({})
assert.equal(completed.result.status, 'completed')
assert.equal(
  completed.statements.filter((sql) => (
    sql.includes('renew_operations_commerce_storage_maintenance')
  )).length,
  5,
  'Every bounded purge group must renew the persisted lease',
)

const staleCompletion = await runLeaseScenario({ complete: false })
assert.equal(staleCompletion.result.status, 'lease_lost')
assert.equal(
  staleCompletion.result.errorCode,
  'COMMERCE_STORAGE_MAINTENANCE_LEASE_LOST',
)

const lostRenewal = await runLeaseScenario({ renew: false })
assert.equal(lostRenewal.result.status, 'lease_lost')
assert.equal(
  lostRenewal.result.errorCode,
  'COMMERCE_STORAGE_MAINTENANCE_LEASE_LOST',
)

const healthStatements = []
const healthMaintenance = loadMaintenance(async (sql) => {
  healthStatements.push(sql)
  if (sql.includes('schema_migrations')) {
    return { rows: [{ migration_applied: true }] }
  }
  return {
    rows: [{
      next_run_at: '2026-09-04T12:00:00.000Z',
      lease_owner: 'worker-one',
      lease_expires_at: '2026-09-04T12:02:00.000Z',
      lease_active: false,
      lease_expired: true,
      last_started_at: '2026-09-04T12:00:00.000Z',
      last_completed_at: null,
      last_failed_at: '2026-09-04T12:01:00.000Z',
      last_error_code: 'SIMULATED_STORAGE_FAILURE',
      last_result: { status: 'failed' },
      row_version: '9',
    }],
  }
})
const health = await healthMaintenance
  .readCommerceStorageBloatHealthFromPostgres()
assert.equal(health.schemaAvailable, true)
assert.equal(health.diagnosticsMode, 'persisted-maintenance')
assert.equal(health.storageMaintenance.leaseExpired, true)
assert.equal(
  health.storageMaintenance.lastErrorCode,
  'SIMULATED_STORAGE_FAILURE',
)
assert.equal(health.storageMaintenance.rowVersion, 9)
assert.ok(
  healthStatements.every((sql) => (
    !sql.includes('operations_commerce_storage_bloat_health')
  )),
  'The liveness endpoint must not run global ranked-storage diagnostics',
)

console.log(
  'commerce storage maintenance runtime contracts passed '
  + '(per-group renewal, lease-loss completion, and persisted health)',
)
