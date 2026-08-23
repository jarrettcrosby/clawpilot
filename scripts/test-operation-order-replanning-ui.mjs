#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [operations, route, types] = await Promise.all([
  readFile(
    new URL('../app_src/components/operations/OperationsSection.tsx', import.meta.url),
    'utf8',
  ),
  readFile(
    new URL('../app_src/app/api/operations/route.ts', import.meta.url),
    'utf8',
  ),
  readFile(
    new URL('../app_src/lib/operations/types.ts', import.meta.url),
    'utf8',
  ),
])

for (const fragment of [
  "item.action === 'reopen_for_replanning'",
  'onReopenForReplanning',
  'Reopen order for replanning?',
  'Confirm operational correction',
  'I reviewed this exact unreleased plan',
  'Minimum 8 characters',
  'expectedPlanGlobalId: action.expectedPlanGlobalId',
  'expectedPlanVersion: action.expectedPlanVersion',
  'expectedCorrectionFingerprint:',
  "action: 'reopen-order-for-replanning'",
  "'Idempotency-Key': replanningCorrectionIdempotencyKey",
  'operations-replanning:',
  'no carrier or storefront call was made',
]) {
  assert.ok(
    operations.includes(fragment),
    `Active correction UI is missing ${fragment}`,
  )
}

assert.match(
  operations,
  /variant="outlined"[\s\S]*?color="warning"[\s\S]*?onClick=\{onReopenForReplanning\}/u,
  'Correction must remain a secondary warning action',
)
assert.match(
  operations,
  /replanningCorrectionReason\.trim\(\)\.length < 8[\s\S]*?!replanningCorrectionConfirmed/u,
  'Correction confirmation must require an eight-character reason and explicit acknowledgment',
)
const submitStart = operations.indexOf(
  'const reopenForReplanning = async',
)
const submitEnd = operations.indexOf(
  'const openConfirmPicks =',
  submitStart,
)
const submit = operations.slice(submitStart, submitEnd)
assert.ok(submitStart >= 0 && submitEnd > submitStart)
assert.equal(
  submit.includes('crypto.randomUUID()'),
  false,
  'Retries must reuse the idempotency key created when the dialog opened',
)

const routeBranchStart = route.indexOf(
  "if (action === 'reopen-order-for-replanning')",
)
const routeBranchEnd = route.indexOf(
  "if (action === 'assign-picks')",
  routeBranchStart,
)
assert.ok(routeBranchStart >= 0 && routeBranchEnd > routeBranchStart)
const routeBranch = route.slice(routeBranchStart, routeBranchEnd)
for (const fragment of [
  "if (action === 'reopen-order-for-replanning')",
  "if (!capabilities.canManage)",
  "code: 'OPERATIONS_MANAGE_REQUIRED'",
  "if (!capabilities.canExecute)",
  "code: 'OPERATIONS_EXECUTE_REQUIRED'",
  "'expectedRowVersion'",
  "'expectedPlanGlobalId'",
  "'expectedPlanVersion'",
  "'expectedCorrectionFingerprint'",
  "'reason'",
  'reopenOperationsOrderForReplanningInPostgres',
  'result.replayed ? 200 : 201',
]) {
  assert.ok(
    routeBranch.includes(fragment),
    `Correction API is missing ${fragment}`,
  )
}
assert.equal(types.includes('cancelledWaveGlobalId'), false)
assert.equal(types.includes('cancelledPickTaskCount'), false)

for (const fragment of [
  "| 'reopen_for_replanning'",
  'OperationsOrderReplanningCorrectionResult',
  'providerReads: 0',
  'providerWrites: 0',
]) {
  assert.ok(types.includes(fragment), `Correction contract is missing ${fragment}`)
}

// Preserve the already-landed Shadow sealed-evidence branch while adding the
// Active-only manager control.
for (const fragment of [
  'trainingTarget?.cartonizationEvidenceGlobalId',
  'if (detail && !sealedTrainingEvidence)',
  'This evidence is reused exactly as sealed',
]) {
  assert.ok(operations.includes(fragment), `Shadow training regressed at ${fragment}`)
}

console.log('Independent order-replanning web contract passed.')
