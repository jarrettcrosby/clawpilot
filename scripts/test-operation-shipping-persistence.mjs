#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function section(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `${label} is missing start marker: ${startMarker}`)
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length
  assert.notEqual(end, -1, `${label} is missing end marker: ${endMarker}`)
  return source.slice(start, end)
}

function assertIncludes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} is missing ${fragment}`)
  }
}

function assertOrder(source, markers, label) {
  let previous = -1
  for (const marker of markers) {
    const index = source.indexOf(marker)
    assert.notEqual(index, -1, `${label} is missing ordering marker: ${marker}`)
    assert.ok(index > previous, `${label} has an invalid order at: ${marker}`)
    previous = index
  }
}

const migration = read('db/migrations/0098_operations_label_execution.sql')
const persistence = read('app_src/lib/persistence/operationShipping.ts')

const attemptTable = section(
  migration,
  'CREATE TABLE IF NOT EXISTS operations_label_attempts',
  'ALTER TABLE operations_labels',
  'Label-attempt table',
)
assertIncludes(attemptTable, [
  "action text NOT NULL CHECK (action IN ('create', 'void', 'reconcile'))",
  "state text NOT NULL DEFAULT 'prepared'",
  "CHECK (state IN ('prepared', 'succeeded', 'failed', 'unknown'))",
  'idempotency_key text NOT NULL',
  'request_hash text NOT NULL',
  'redacted_request jsonb NOT NULL',
  "UNIQUE (organization_id, action, idempotency_key)",
  "state = 'prepared' AND completed_at IS NULL",
  "state <> 'prepared' AND completed_at IS NOT NULL",
], 'Label-attempt lifecycle')
assert.ok(
  !attemptTable.includes('ON DELETE CASCADE'),
  'Label-attempt evidence must not cascade-delete with related records',
)

assert.match(
  migration,
  /CREATE UNIQUE INDEX IF NOT EXISTS\s+operations_labels_one_active_per_package\s+ON operations_labels \(organization_id, package_id\)\s+WHERE status = 'created';/s,
  'Migration must enforce one active label per package',
)

const attemptProtection = section(
  migration,
  'CREATE OR REPLACE FUNCTION protect_operations_label_attempt()',
  'COMMENT ON TABLE operations_label_attempts',
  'Label-attempt protection trigger',
)
assertIncludes(attemptProtection, [
  "IF TG_OP = 'DELETE' THEN",
  'Carrier label attempts are immutable and cannot be deleted',
  'Carrier label attempt identity and request evidence are immutable',
  "IF OLD.state <> 'prepared' THEN",
  'Terminal carrier label attempts are immutable',
  "IF NEW.state = 'prepared' OR NEW.completed_at IS NULL THEN",
  'Carrier label attempt must finalize exactly once',
  'BEFORE UPDATE OR DELETE ON operations_label_attempts',
], 'Label-attempt protection trigger')
assert.doesNotMatch(
  persistence,
  /DELETE\s+FROM\s+operations_label_attempts/i,
  'Persistence must never delete durable carrier attempts',
)

const attemptUpdates = [
  ...persistence.matchAll(/`UPDATE operations_label_attempts[\s\S]*?`/g),
].map((match) => match[0])
assert.ok(attemptUpdates.length >= 4, 'Expected create, void, failure, and unknown finalizers')
for (const update of attemptUpdates) {
  assert.ok(
    update.includes("AND state = 'prepared'"),
    'Every attempt finalizer must compare-and-set from prepared',
  )
  assert.ok(update.includes('completed_at = now()'), 'Every terminal attempt update needs completion time')
}

const unresolvedGuard = section(
  persistence,
  'async function assertNoUnresolvedAttempt(',
  'function assertCreateContext(',
  'Unresolved-attempt guard',
)
assertIncludes(unresolvedGuard, [
  "state IN ('prepared', 'unknown')",
  'FOR SHARE',
  "'OPERATIONS_LABEL_RECONCILIATION_REQUIRED'",
  'must be reconciled before another carrier command',
], 'Unresolved-attempt guard')

const createContextGuard = section(
  persistence,
  'function assertCreateContext(',
  'function assertVoidContext(',
  'Create-label local safeguards',
)
assertIncludes(createContextGuard, [
  "'OPERATIONS_LABEL_ORDER_NOT_PACKED'",
  "'OPERATIONS_ORDER_VERSION_CONFLICT'",
  "'OPERATIONS_LABEL_RERATE_REQUIRED'",
  "'OPERATIONS_LABEL_ALREADY_CREATED'",
], 'Create-label local safeguards')
assert.doesNotMatch(
  createContextGuard,
  /activation_state|OPERATIONS_LABEL_ACTIVE_MODE_REQUIRED/u,
  'Sandbox label creation must not depend on workspace activation',
)

const voidContextGuard = section(
  persistence,
  'function assertVoidContext(',
  'function commandHash(',
  'Void-label local safeguards',
)
assertIncludes(voidContextGuard, [
  "'OPERATIONS_LABEL_ORDER_NOT_PACKED'",
  "'OPERATIONS_ORDER_VERSION_CONFLICT'",
  "'OPERATIONS_LABEL_VOID_UNAVAILABLE'",
], 'Void-label local safeguards')
assert.doesNotMatch(
  voidContextGuard,
  /activation_state|OPERATIONS_LABEL_ACTIVE_MODE_REQUIRED/u,
  'Sandbox label void must not depend on workspace activation',
)

const replay = section(
  persistence,
  'async function replayResult(',
  'function assertAttemptInputMatches(',
  'Attempt replay',
)
assertIncludes(replay, [
  "attempt.state === 'unknown' || attempt.state === 'prepared'",
  "'OPERATIONS_LABEL_RECONCILIATION_REQUIRED'",
  'must be reconciled',
], 'Attempt replay')

const prepare = section(
  persistence,
  'async function prepareAttempt(',
  'async function finalizeProviderFailure(',
  'Attempt preparation',
)
assertOrder(prepare, [
  'return withTransaction(async (client) => {',
  'await acquireTransactionAdvisoryLock(',
  'const existing = await findExistingAttempt(client, input)',
  'const context = await readShippingContext(',
  'await assertNoUnresolvedAttempt(client, input.organizationId, context.package.id)',
  '`INSERT INTO operations_label_attempts (',
], 'Attempt preparation')
assertIncludes(prepare, [
  'input.runtime.integrationAccountId',
  'input.runtime.carrierAccountId',
  'CARRIER_SANDBOX_LABEL_ADAPTER_VERSION',
], 'Attempt preparation')

const commandFingerprint = section(
  persistence,
  'function commandHash(',
  'function safeProviderResponse(',
  'Carrier command fingerprint',
)
assertIncludes(commandFingerprint, [
  'carrierAccountGlobalId: input.runtime.carrierAccountGlobalId',
  'billingRelationship: input.runtime.billingRelationship',
  'providerRequestHash: input.providerEvidence.requestHash',
], 'Carrier command fingerprint')

const failureFinalizers = section(
  persistence,
  'async function finalizeProviderFailure(',
  'async function appendLabelEvent(',
  'Failure finalizers',
)
assertIncludes(failureFinalizers, [
  "input.error.uncertain ? 'unknown' : 'failed'",
  "SET state = 'unknown'",
  "error_code = 'OPERATIONS_LABEL_PERSISTENCE_UNKNOWN'",
  "AND state = 'prepared'",
  'A prepared attempt still blocks a duplicate purchase if Postgres is unavailable.',
], 'Failure finalizers')

const replayPrintRecovery = section(
  persistence,
  'async function recoverCreateReplayPrint(',
  'export async function createOperationsSandboxLabelInPostgres(',
  'Create-label replay print recovery',
)
assertIncludes(replayPrintRecovery, [
  "if (input.replay.labelStatus !== 'created') return input.replay",
  'const print = await enqueueLabelPrint({',
  'warehouseId: await readLabelWarehouseId(',
  'return { ...input.replay, ...print }',
], 'Create-label replay print recovery')

const createCommand = section(
  persistence,
  'export async function createOperationsSandboxLabelInPostgres(',
  'export async function voidOperationsSandboxLabelInPostgres(',
  'Create-label command',
)
assert.equal(
  [...createCommand.matchAll(/return recoverCreateReplayPrint\(\{/g)].length,
  2,
  'Both early and lock-race create replays must recover the idempotent print job',
)
assertOrder(createCommand, [
  "action: 'create'",
  'const prepared = await prepareAttempt({',
  'providerResult = await createCarrierSandboxLabel({',
  'result = await withTransaction(async (client) => {',
  '`INSERT INTO operations_labels (',
  '`UPDATE operations_label_attempts',
  "SET state = 'succeeded'",
  "SET status = 'labeled'",
  'const print = await enqueueLabelPrint({',
  'return { ...result, ...print }',
], 'Create-label prepare/call/finalize/print flow')
assertIncludes(createCommand, [
  'await markFinalizeUnknown({',
  "'OPERATIONS_LABEL_RECONCILIATION_REQUIRED'",
  'The carrier created a label, but ClawPilot could not finalize it',
], 'Create-label uncertain finalization')
assertIncludes(createCommand, [
  'senderBillingOnly: Boolean(sandboxE2eAuthorizationGlobalId)',
], 'Authorized package-label sender billing')

const createFinalizeStart = createCommand.indexOf(
  'result = await withTransaction(async (client) => {',
)
const createFinalizeCatch = createCommand.indexOf(
  '\n  } catch {\n    await markFinalizeUnknown({',
  createFinalizeStart,
)
const printEnqueue = createCommand.indexOf('const print = await enqueueLabelPrint({')
assert.ok(createFinalizeStart >= 0 && createFinalizeCatch > createFinalizeStart)
assert.ok(
  printEnqueue > createFinalizeCatch,
  'Print enqueue must occur only after carrier result finalization commits',
)
assert.ok(
  !createCommand.slice(createFinalizeStart, createFinalizeCatch).includes('enqueueLabelPrint'),
  'Print enqueue must not run inside the carrier finalization transaction',
)

const voidInput = section(
  persistence,
  'type VoidSandboxLabelInput = {',
  'const UUID =',
  'Void-label input',
)
assert.ok(
  !voidInput.includes('carrierAccountGlobalId'),
  'Void must not accept a replacement carrier account from the caller',
)

const contextRead = section(
  persistence,
  'async function readShippingContext(',
  'async function assertNoUnresolvedAttempt(',
  'Shipping context read',
)
assertIncludes(contextRead, [
  'carrier_account.global_id AS carrier_account_global_id',
  'AND carrier_account.id = label.carrier_account_id',
  "AND label.status = 'created'",
], 'Shipping context read')

const voidCommand = section(
  persistence,
  'export async function voidOperationsSandboxLabelInPostgres(',
  null,
  'Void-label command',
)
assertOrder(voidCommand, [
  'initial = await readShippingContext(',
  'runtime = await resolveCarrierSandboxShippingRuntime({',
  'provider: providerForCarrier(initial.activeLabel.carrier)',
  'carrierAccountGlobalId: initial.activeLabel.carrier_account_global_id',
  'const prepared = await prepareAttempt({',
  'carrierRateGlobalId: initial.activeLabel.carrier_rate_global_id',
  'providerResult = await voidCarrierSandboxLabel({',
  'trackingNumber: activeLabel.tracking_number',
  'providerReference: activeLabel.provider_label_id',
  'return await withTransaction(async (client) => {',
  "SET status = 'voided'",
  "SET state = 'succeeded'",
], 'Void-label exact-account prepare/call/finalize flow')
assertIncludes(voidCommand, [
  'await markFinalizeUnknown({',
  "'OPERATIONS_LABEL_RECONCILIATION_REQUIRED'",
  'The carrier voided the label, but ClawPilot could not finalize it',
], 'Void-label uncertain finalization')
assert.ok(
  !voidCommand.includes('enqueueLabelPrint'),
  'Voiding a label must not enqueue another print job',
)

console.log('Operation shipping persistence contract checks passed.')
