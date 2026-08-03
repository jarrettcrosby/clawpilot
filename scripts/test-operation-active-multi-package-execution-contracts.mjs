#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ActiveFulfillmentExecutionError,
  assertActiveCarrierGroupAttemptDispatchable,
  finalizeActiveCarrierGroupAttempt,
  prepareActiveFulfillmentExecution,
  recordPersistedActiveCarrierGroupAttempt,
} from '../app_src/lib/operations/activeFulfillmentExecution.ts'

const root = process.cwd()
const migration = readFileSync(
  resolve(
    root,
    'db/migrations/0179_operations_active_multi_package_execution.sql',
  ),
  'utf8',
)
const shadowMigration = readFileSync(
  resolve(root, 'db/migrations/0177_operations_fulfillment_executions.sql'),
  'utf8',
)

function section(startMarker, endMarker, label) {
  const start = migration.indexOf(startMarker)
  assert.notEqual(start, -1, `${label} is missing ${startMarker}`)
  const end = migration.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(end, -1, `${label} is missing ${endMarker}`)
  return migration.slice(start, end)
}

function assertIncludes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} is missing ${fragment}`)
  }
}

function expectCode(action, expectedCode) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof ActiveFulfillmentExecutionError)
    assert.equal(error.code, expectedCode)
    return true
  })
}

const executionInput = {
  activationState: 'active',
  activationRevision: 17,
  shadowExecutionId: 'shadow-execution-1',
  orderId: 'order-1',
  planId: 'plan-1',
  warehouseId: 'warehouse-1',
  idempotencyKey: 'active-execution:order-1:r17',
  selection: {
    provider: 'ups_rest',
    serviceCode: '03',
    serviceName: 'UPS Ground',
    currency: 'usd',
    carrierCostMinor: 2_145,
  },
  packages: [
    { packageId: 'package-2', packageKey: 'box#0002', packageNumber: 2 },
    { packageId: 'package-1', packageKey: 'box#0001', packageNumber: 1 },
  ],
}

const prepared = prepareActiveFulfillmentExecution(executionInput)
assert.equal(prepared.authorityMode, 'active')
assert.equal(prepared.state, 'prepared')
assert.equal(prepared.packageCount, 2)
assert.equal(prepared.packages[0].packageId, 'package-1')
assert.equal(prepared.selection.currency, 'USD')
assert.match(prepared.requestHash, /^[a-f0-9]{64}$/u)
assert.equal(
  prepareActiveFulfillmentExecution({
    ...executionInput,
    packages: [...executionInput.packages].reverse(),
  }).requestHash,
  prepared.requestHash,
  'Package input order must not change the immutable request identity',
)
assert.ok(Object.isFrozen(prepared))
assert.ok(Object.isFrozen(prepared.packages))

expectCode(
  () => prepareActiveFulfillmentExecution({
    ...executionInput,
    activationState: 'shadow',
  }),
  'OPERATIONS_ACTIVE_AUTHORITY_REQUIRED',
)
expectCode(
  () => prepareActiveFulfillmentExecution({
    ...executionInput,
    packages: [executionInput.packages[0], executionInput.packages[0]],
  }),
  'OPERATIONS_ACTIVE_PACKAGE_IDENTITY_INVALID',
)

const persisted = recordPersistedActiveCarrierGroupAttempt({
  attemptId: 'carrier-group-attempt-1',
  persistedAt: '2026-07-31T12:00:00.000Z',
  idempotencyKey: 'carrier-group-attempt:order-1:r17',
  execution: prepared,
})
assert.equal(persisted.state, 'prepared')
assert.equal(persisted.attemptNumber, 1)
assert.equal(persisted.packageCount, 2)
assert.deepEqual(persisted.packageIds, ['package-1', 'package-2'])
assert.ok(Object.isFrozen(persisted.packageIds))
assert.doesNotThrow(() => assertActiveCarrierGroupAttemptDispatchable(persisted))

expectCode(
  () => finalizeActiveCarrierGroupAttempt(persisted, {
    state: 'succeeded',
    dispatchedAt: '2026-07-31T12:00:01.000Z',
    completedAt: '2026-07-31T12:00:02.000Z',
    providerReference: 'provider-group-1',
    packageResults: [{
      packageId: 'package-1',
      packageNumber: 1,
      labelId: 'label-1',
      shipmentId: 'shipment-1',
      trackingNumber: '1Z0000000000000001',
      providerPackageReference: 'provider-package-1',
    }],
  }),
  'OPERATIONS_ACTIVE_PACKAGE_RESULTS_INCOMPLETE',
)

const succeeded = finalizeActiveCarrierGroupAttempt(persisted, {
  state: 'succeeded',
  dispatchedAt: '2026-07-31T12:00:01.000Z',
  completedAt: '2026-07-31T12:00:02.000Z',
  providerReference: 'provider-group-1',
  packageResults: [
    {
      packageId: 'package-2',
      packageNumber: 2,
      labelId: 'label-2',
      shipmentId: 'shipment-2',
      trackingNumber: '1Z0000000000000002',
      providerPackageReference: 'provider-package-2',
    },
    {
      packageId: 'package-1',
      packageNumber: 1,
      labelId: 'label-1',
      shipmentId: 'shipment-1',
      trackingNumber: '1Z0000000000000001',
      providerPackageReference: 'provider-package-1',
    },
  ],
})
assert.equal(succeeded.packageResults.length, 2)
assert.equal(succeeded.packageResults[0].packageId, 'package-1')
expectCode(
  () => assertActiveCarrierGroupAttemptDispatchable(succeeded),
  'OPERATIONS_ACTIVE_CARRIER_ATTEMPT_TERMINAL',
)

const unknown = finalizeActiveCarrierGroupAttempt(persisted, {
  state: 'unknown',
  dispatchedAt: '2026-07-31T12:00:01.000Z',
  completedAt: '2026-07-31T12:00:31.000Z',
  errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
})
expectCode(
  () => assertActiveCarrierGroupAttemptDispatchable(unknown),
  'OPERATIONS_ACTIVE_CARRIER_OUTCOME_UNKNOWN_RECONCILIATION_REQUIRED',
)
expectCode(
  () => recordPersistedActiveCarrierGroupAttempt({
    attemptId: 'carrier-group-attempt-2',
    persistedAt: '2026-07-31T12:01:00.000Z',
    idempotencyKey: 'carrier-group-attempt:order-1:r17:retry',
    execution: prepared,
    previousAttempt: unknown,
  }),
  'OPERATIONS_ACTIVE_CARRIER_OUTCOME_UNKNOWN_RECONCILIATION_REQUIRED',
)
const failed = finalizeActiveCarrierGroupAttempt(persisted, {
  state: 'failed',
  dispatchedAt: '2026-07-31T12:00:01.000Z',
  completedAt: '2026-07-31T12:00:02.000Z',
  errorCode: 'PROVIDER_REJECTED_REQUEST',
})
const retry = recordPersistedActiveCarrierGroupAttempt({
  attemptId: 'carrier-group-attempt-2',
  persistedAt: '2026-07-31T12:01:00.000Z',
  idempotencyKey: 'carrier-group-attempt:order-1:r17:retry',
  execution: prepared,
  previousAttempt: failed,
})
assert.equal(retry.attemptNumber, 2)
assert.doesNotThrow(() => assertActiveCarrierGroupAttemptDispatchable(retry))

const executionTable = section(
  'CREATE TABLE IF NOT EXISTS operations_active_fulfillment_executions',
  'CREATE TABLE IF NOT EXISTS operations_active_shipment_groups',
  'Active execution table',
)
const groupTable = section(
  'CREATE TABLE IF NOT EXISTS operations_active_shipment_groups',
  'CREATE TABLE IF NOT EXISTS operations_active_execution_packages',
  'Active shipment-group table',
)
const packageTable = section(
  'CREATE TABLE IF NOT EXISTS operations_active_execution_packages',
  'CREATE TABLE IF NOT EXISTS operations_active_carrier_group_attempts',
  'Active execution-package table',
)
const attemptTable = section(
  'CREATE TABLE IF NOT EXISTS operations_active_carrier_group_attempts',
  'CREATE TABLE IF NOT EXISTS operations_active_carrier_package_results',
  'Active carrier group-attempt table',
)
const resultTable = section(
  'CREATE TABLE IF NOT EXISTS operations_active_carrier_package_results',
  'ALTER TABLE operations_label_attempts',
  'Active package-result table',
)
const sharedLineageGuard = section(
  'CREATE OR REPLACE FUNCTION\n  validate_operations_active_fulfillment_lineage_write()',
  'CREATE TRIGGER validate_operations_label_attempt_active_lineage',
  'Shared label and shipment lineage guard',
)

assertIncludes(executionTable, [
  'shadow_fulfillment_execution_id uuid NOT NULL',
  "authority_mode text NOT NULL CHECK (authority_mode = 'active')",
  "state text NOT NULL CHECK (state = 'prepared')",
  'activation_revision integer NOT NULL',
  'REFERENCES operations_fulfillment_executions(organization_id, id)',
  'operations_active_fulfillment_executions_shadow_unique',
], 'Separate Active execution')
assert.doesNotMatch(
  migration,
  /ALTER TABLE operations_fulfillment_executions\s+(?:ADD|ALTER|DROP)/u,
  'Migration 0179 must not widen or mutate immutable Shadow execution rows',
)
assertIncludes(shadowMigration, [
  "authority_mode text NOT NULL CHECK (authority_mode = 'shadow')",
  "state text NOT NULL CHECK (state = 'shadow_prepared')",
  'Shadow fulfillment preparation evidence is immutable',
], 'Migration 0177 immutable Shadow source')

assertIncludes(groupTable, [
  "selected_provider IN ('ups_rest', 'fedex_rest')",
  'selected_service_code text NOT NULL',
  'selected_service_name text NOT NULL',
  'package_count integer NOT NULL CHECK (package_count BETWEEN 1 AND 50)',
  'operations_active_shipment_groups_execution_unique UNIQUE',
], 'Whole-shipment service selection')
for (const forbidden of [
  'selected_provider',
  'selected_service_code',
  'selected_service_name',
  'carrier_provider',
]) {
  assert.ok(
    !packageTable.includes(forbidden),
    `Per-package table must not select ${forbidden}`,
  )
}

assertIncludes(attemptTable, [
  "state IN ('prepared', 'succeeded', 'failed', 'unknown')",
  "environment text NOT NULL CHECK (environment = 'production')",
  'persisted_at timestamptz NOT NULL DEFAULT now()',
  'attempt_number integer NOT NULL CHECK (attempt_number >= 1)',
  'operations_active_carrier_group_attempts_number_unique UNIQUE',
  'operations_active_carrier_group_attempts_idempotency_unique',
], 'Durable one-attempt group boundary')
assertIncludes(resultTable, [
  'carrier_group_attempt_id uuid NOT NULL',
  'package_id uuid NOT NULL',
  'label_id uuid',
  'shipment_id uuid',
  'operations_active_carrier_package_results_label_fkey',
  'operations_active_carrier_package_results_shipment_fkey',
  'operations_active_carrier_package_results_package_unique UNIQUE',
], 'N package label and shipment results')

assertIncludes(migration, [
  'ADD COLUMN IF NOT EXISTS active_fulfillment_execution_id uuid',
  'ADD COLUMN IF NOT EXISTS active_shipment_group_id uuid',
  'ADD COLUMN IF NOT EXISTS active_carrier_group_attempt_id uuid',
  'Production carrier label writes require Operations Active',
  'Production shipment writes require Operations Active',
  'Active fulfillment carrier-write lineage requires production evidence',
  "row_environment := to_jsonb(NEW)->>'environment'",
  'Terminal Active carrier group attempt cannot be retried or changed',
  'Prepared, succeeded, or unknown Active carrier attempt cannot be retried',
  'operations_active_carrier_group_attempts_open_unique',
  'Succeeded Active attempt requires one matching label and shipment for every package',
  'Active execution requires one exact Shadow-derived package group, service, and durable carrier attempt',
], 'Active database safety boundary')
assert.doesNotMatch(
  sharedLineageGuard,
  /\bNEW\.environment\b/u,
  'The shared label/shipment trigger cannot access a shipment-only missing field',
)
assert.equal(
  (migration.match(/operations_active_carrier_group_attempts_open_unique/g) || [])
    .length,
  1,
  'One carrier group must have at most one non-failed dispatch attempt',
)

console.log('Active multi-package execution contracts passed.')
