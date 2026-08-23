#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const [historicalExecution, historicalAddress, migration] = await Promise.all([
  read('db/migrations/0179_operations_active_multi_package_execution.sql'),
  read('db/migrations/0310_operations_order_shipment_address_working_copy.sql'),
  read('db/migrations/0315_operations_carrier_writes_independent_activation.sql'),
])

assert.equal(
  sha256(historicalExecution),
  'c2e0dc825d87c2ec90a71b5fcf6834b8af6ab59082167ce7215c2b5b7a0a4d23',
  '0315 must not rewrite the historical 0179 carrier-execution migration',
)
assert.equal(
  sha256(historicalAddress),
  '6ad6749c89effe427baef8bbdfe51d3a04e8be6bc2ce8922916e901c069b9d06',
  '0315 must not rewrite the historical 0310 effective-address migration',
)
assert.equal(
  sha256(migration),
  'a83731e62dc6253952800709b37db83cdebf593539049b0b0791a64544f34b8d',
  '0315 reviewed migration bytes drifted',
)

const exactFunctions = [
  'public.validate_operations_active_fulfillment_lineage_write()',
  'public.validate_operations_active_execution_prepare()',
  'public.validate_operations_production_rerate_run_insert()',
  'public.validate_operations_production_rerate_attempt_insert()',
  'public.validate_operations_production_rerate_selection_insert()',
  'public.validate_operations_active_carrier_group_attempt_prepare()',
  'public.operations_shopify_test_store_e2e_is_current(',
  'public.validate_operations_carrier_shipping_diagnostic_lineage()',
  'public.maintain_operations_carrier_shipping_diagnostic_authority_lease()',
  'public.protect_operations_carrier_shipping_diagnostic_authority()',
]
for (const signature of exactFunctions) {
  assert.ok(
    migration.includes(signature),
    `0315 is missing the exact replacement ${signature}`,
  )
}
assert.equal(
  migration.match(/CREATE OR REPLACE FUNCTION/gu)?.length,
  exactFunctions.length,
  '0315 may replace only the ten reviewed carrier, diagnostic, and E2E validators',
)
for (const forbidden of [
  'activation_state',
  'current_activation_revision',
  'Operations Active',
]) {
  assert.equal(
    migration.includes(forbidden),
    false,
    `0315 still depends on the legacy activation profile through ${forbidden}`,
  )
}
assert.equal(
  migration.match(/operations_activation_scopes/gu)?.length,
  2,
  '0315 may name the legacy activation relation only to remove its diagnostic protection trigger and retire its legacy counters',
)
assert.ok(
  migration.includes(
    'LOCK TABLE public.operations_carrier_rate_test_label_attempts\n  IN SHARE ROW EXCLUSIVE MODE',
  ),
  '0315 must lock diagnostic-attempt writes across the lease cutover',
)
assert.ok(
  migration.includes(
    'DROP TRIGGER IF EXISTS\n  protect_operations_carrier_shipping_diagnostic_activation\n  ON public.operations_activation_scopes',
  ),
  '0315 must remove the obsolete activation-row diagnostic protection trigger',
)
assert.ok(
  migration.includes(
    'UPDATE public.operations_activation_scopes\nSET production_shipping_diagnostic_lease_count = 0\nWHERE production_shipping_diagnostic_lease_count <> 0',
  ),
  '0315 must retire every legacy activation-row diagnostic lease counter',
)

for (const retainedFence of [
  'Active execution must reference one exact immutable Shadow preparation',
  'active_execution.activation_revision',
  'Production fulfillment rerate must bind one exact Active execution and shipment group',
  'operations_order_dispatch_destination_matches',
  "integration_account.environment IS DISTINCT FROM 'production'",
  "integration_account.status IS DISTINCT FROM 'active'",
  "carrier_account.status IS DISTINCT FROM 'active'",
  "carrier_credential.verification_status IS DISTINCT FROM 'verified'",
  'Production fulfillment rerate billing relationship is not authorized',
  'currently unexpired successful offer',
  'NEW.selected_provider IS DISTINCT FROM selection.provider',
  'NEW.selected_service_code IS DISTINCT FROM selection.service_code',
  'NEW.package_count IS DISTINCT FROM rerate_run.package_count',
  'Prepared, succeeded, or unknown Active carrier attempt cannot be retried',
  'Active shipment lineage must match its production label',
  "auth.confirmation_statement_version =\n            'shopify-test-store-canonical-e2e-v1'",
  "account.environment = 'sandbox'",
  "credential.verification_status = 'verified'",
  "candidate.workflow_state = 'promoted'",
  'candidate.test_order = true',
  'evidence.provider_test = true',
  "evidence.purpose = 'shipping_account_diagnostic'",
  "integration.configuration->'allowedCapabilities'\n          ? 'production_rate'",
  "integration.configuration->'allowedCapabilities'\n          ? 'production_label'",
  "credential.verification_status = 'verified'",
  "carrier_account.allow_sender_billing = true",
  "evidence.billing_selection_snapshot->>'credentialFingerprint'",
  "evidence.billing_selection_snapshot->>'accountNumberFingerprint'",
  "evidence.billing_selection_snapshot->>'registeredAddressFingerprint'",
  "evidence.billing_selection_snapshot->>'senderName'",
  'FOR UPDATE OF integration, credential, carrier_account',
  'LIVE carrier diagnostic authority lease requires its integration',
  'LIVE carrier diagnostic authority lease requires its credential',
  'LIVE carrier diagnostic authority lease requires its sender account',
  'LIVE carrier authority cannot be revoked during a prepared diagnostic',
  'LIVE carrier credential cannot change during a prepared diagnostic',
  'LIVE carrier sender account cannot change during a prepared diagnostic',
]) {
  assert.ok(
    migration.includes(retainedFence),
    `0315 dropped the independent fence: ${retainedFence}`,
  )
}

for (const failClosedProductionFence of [
  'Production carrier label writes require exact carrier authority lineage',
  'Production shipment writes require exact carrier authority lineage',
  "to_jsonb(NEW)->>'one_off_carrier_group_attempt_id'",
  'linked_label_one_off_group_id',
]) {
  assert.ok(
    migration.includes(failClosedProductionFence),
    `0315 is missing fail-closed production lineage: ${failClosedProductionFence}`,
  )
}

for (const separatelyOwnedFunction of [
  'validate_operations_one_off_group_label',
  'validate_operations_one_off_group_shipment',
  'operations_one_off_plan_execution_is_exact',
]) {
  assert.equal(
    migration.includes(`CREATE OR REPLACE FUNCTION ${separatelyOwnedFunction}`),
    false,
    `0315 must not replace separately owned ${separatelyOwnedFunction}`,
  )
}

console.log('Operations production carrier activation-independence contract passed')
