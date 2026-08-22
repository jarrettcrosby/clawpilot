#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [panel, operations] = await Promise.all([
  readFile(
    new URL('../app_src/components/operations/ShadowOrderTrainingPanel.tsx', import.meta.url),
    'utf8',
  ),
  readFile(
    new URL('../app_src/components/operations/OperationsSection.tsx', import.meta.url),
    'utf8',
  ),
])

for (const fragment of [
  'Enable training',
  'Training enabled',
  'Prepare training order',
  'Release training wave',
  'Confirm training picks',
  'Verify training pack',
  'Simulate completion',
  'Undo last training step',
  'Reset training run',
  'store remains the source of truth',
  '0 store writes, 0 production postage, 0 operational inventory changes',
  'run.sourceChanged',
  'window.confirm(',
  'only the last local training step',
  'run.activationChanged',
  'This exact local training run remains available',
  'run.restartRequiredBeforePlan',
  'trainingEvidenceSealed',
  'cartonizationEvidenceGlobalId: run.cartonizationEvidenceGlobalId',
  'Reset this run and enable a new run',
  "run.availableActions.includes('plan')",
  'SHADOW_TRAINING_CONFIRMATION',
]) {
  assert.ok(panel.includes(fragment), `training panel is missing ${fragment}`)
}
for (const forbidden of [
  'Create sandbox label',
  'Print training label',
  "action: 'create-label'",
  "action: 'print-label'",
  'customerGlobalId',
]) {
  assert.equal(panel.includes(forbidden), false, `training panel exposes ${forbidden}`)
}

for (const fragment of [
  '<ShadowOrderTrainingPanel',
  'const trainingProviderOrder',
  "['shopify', 'faire'].includes(order.sourceProvider)",
  '<DetailSection title="Order training">',
  'setShadowTrainingPlanTarget(trainingTarget || null)',
  'setPlanCartonizationEvidenceGlobalId(sealedTrainingEvidence)',
  'if (detail && !sealedTrainingEvidence)',
  "fetch('/api/operations/training'",
  "action: 'plan'",
  'Confirm local training plan',
  'shadowTraining: shadowTrainingPlanTarget',
  '!shadowTrainingPlanTarget,',
  'stock is shown for context but is not consumed',
  'zero canonical reservations, inventory changes, warehouse',
  'No new carrier request, commerce-provider',
  'This evidence is reused exactly as sealed',
  'store writes',
  'const primaryAction = canPlanImportedOrder',
]) {
  assert.ok(operations.includes(fragment), `Operations training integration is missing ${fragment}`)
}
assert.doesNotMatch(
  operations,
  /order\.sourceProvider === 'shopify' && activationState !== 'shadow'/,
  'global Operations Shadow must not hide the per-account Shopify editor',
)
assert.match(
  operations,
  /const assignmentRequest = order\.sourceProvider === 'shopify'\s*&& !localTraining\s*\? fetch/,
  'local training must not depend on a live Shopify planning-assignment read',
)

const mirrorOnlyStart = operations.indexOf('const primaryAction')
const primaryActionEnd = operations.indexOf(
  "const confirmingPicks = primaryAction?.action",
  mirrorOnlyStart,
)
const mirrorOnlyPrimaryAction = operations.slice(mirrorOnlyStart, primaryActionEnd)
assert.equal(
  operations.includes('const shadowProviderOrder'),
  false,
  'the legacy Shadow profile must not hide ordinary local order actions',
)
assert.ok(
  mirrorOnlyPrimaryAction.includes('reconcileExternalFulfillmentAction'),
  'provider reconciliation must remain visible independent of profile',
)
assert.match(
  mirrorOnlyPrimaryAction,
  /: order\?\.status === 'released'[\s\S]*\? reconcileExternalFulfillmentAction[\s\S]*: confirmPicksAction/,
  'ordinary released work must remain actionable in every profile',
)

console.log('Shadow exact-order training UI contract passed.')
