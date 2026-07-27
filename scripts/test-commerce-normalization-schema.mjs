#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migrationPath = resolve(
  process.cwd(),
  'db/migrations/0114_operations_commerce_normalization.sql',
)
const migration = readFileSync(migrationPath, 'utf8')
const continuationMigration = readFileSync(resolve(
  process.cwd(),
  'db/migrations/0115_operations_commerce_intake_continuations.sql',
), 'utf8')
const operationsPersistence = readFileSync(resolve(
  process.cwd(),
  'app_src/lib/persistence/operations.ts',
), 'utf8')
const developmentSeed = readFileSync(resolve(
  process.cwd(),
  'scripts/seed-wms-development-simulation.mjs',
), 'utf8')

function includesAll(fragments, label) {
  for (const fragment of fragments) {
    assert.ok(
      migration.includes(fragment),
      `${label} missing required contract: ${fragment}`,
    )
  }
}

function includesAllIn(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(
      source.includes(fragment),
      `${label} missing required contract: ${fragment}`,
    )
  }
}

function sqlSection(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `${label} missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `${label} missing end marker: ${endMarker}`)
  return source.slice(start, end)
}

includesAll([
  "('gcir', 'operations.commerce_intake_run'",
  "('gcpc', 'operations.commerce_product_candidate'",
  "('gcoc', 'operations.commerce_order_candidate'",
  "('gcol', 'operations.commerce_order_candidate_line'",
  "('gcrd', 'operations.commerce_resolution_decision'",
], 'Global ID registry')

includesAll([
  'CREATE TABLE IF NOT EXISTS operations_commerce_intake_runs',
  'CREATE TABLE IF NOT EXISTS operations_commerce_product_candidates',
  'CREATE TABLE IF NOT EXISTS operations_commerce_order_candidates',
  'CREATE TABLE IF NOT EXISTS operations_commerce_order_candidate_lines',
  'CREATE TABLE IF NOT EXISTS operations_commerce_resolution_decisions',
], 'Normalization schema')

includesAll([
  "'held', 'resolving', 'ready', 'promoted', 'failed', 'expired'",
  "WHEN 'held' THEN next_state IN (\n      'held', 'resolving', 'ready'",
  'operations_commerce_workflow_transition_valid',
  'row_version bigint NOT NULL DEFAULT 0',
  'update requires the next row version',
], 'Lifecycle and concurrency')

includesAll([
  'external_variant_id text',
  'idx_operations_product_mappings_exact_variant',
  'organization_id, integration_account_id, external_variant_id',
  "AND mapping_method = 'legacy_sku'",
  'Commerce product mapping provider variant identity is immutable',
], 'Exact provider variant identity')
for (const [source, label] of [
  [operationsPersistence, 'Operations proof legacy SKU upsert'],
  [developmentSeed, 'Development seed legacy SKU upsert'],
]) {
  includesAllIn(source, [
    'ON CONFLICT (organization_id, integration_account_id, channel_sku)',
    'WHERE channel_sku IS NOT NULL',
    "AND mapping_method = 'legacy_sku'",
  ], label)
}

includesAll([
  'provider_order_status_raw text NOT NULL',
  'provider_financial_status_raw text NOT NULL',
  'provider_fulfillment_status_raw text NOT NULL',
  'provider_return_status_raw text NOT NULL',
  'normalized_order_status text NOT NULL',
  'normalized_payment_status text NOT NULL',
  'normalized_fulfillment_status text NOT NULL',
  'normalized_return_status text NOT NULL',
  'provider_requested_delivery_at timestamptz',
  'requested_delivery_at = provider_requested_delivery_at',
], 'Raw and normalized status separation')

includesAll([
  'subtotal_minor bigint NOT NULL',
  'discount_minor bigint NOT NULL',
  'brand_discount_minor bigint NOT NULL',
  'shipping_minor bigint NOT NULL',
  'tax_minor bigint NOT NULL',
  'total_minor bigint NOT NULL',
  'presentment_total_minor bigint',
  'merchant_payout_minor bigint',
], 'Integer minor-unit money')

includesAll([
  'currency_code text,',
  'unit_price_minor bigint,',
  'subtotal_minor bigint,',
  "price_resolution_state text NOT NULL DEFAULT 'unresolved'",
  'resolved_currency_code text',
  'resolved_unit_price_minor bigint',
  'resolved_total_minor bigint',
  "OR 'line_price_required' = ANY(blocking_codes)",
  "price_resolution_state IN ('provider', 'manual')",
], 'Unavailable and resolved line price boundary')

includesAll([
  'party_snapshot_ciphertext bytea',
  'ship_to_snapshot_ciphertext bytea',
  'operations_commerce_protected_snapshot_valid',
  'octet_length(snapshot_iv) = 12',
  'octet_length(snapshot_tag) = 16',
], 'Protected party and address snapshots')

for (const forbidden of [
  'raw_payload',
  'provider_payload',
  'party_snapshot jsonb',
  'ship_to_snapshot jsonb',
]) {
  assert.ok(
    !migration.toLowerCase().includes(forbidden),
    `Normalization schema must not persist ${forbidden}`,
  )
}

includesAll([
  "provider_access_mode text NOT NULL DEFAULT 'read_only'",
  'CHECK (provider_access_mode = \'read_only\')',
  'provider_write_count integer NOT NULL DEFAULT 0',
  'CHECK (provider_write_count = 0)',
  "attempt_action IS DISTINCT FROM 'commerce.intake.read'",
  'Commerce intake run can reference only a read provider attempt',
  'CHECK (sync_cursor_advanced = false)',
  'CHECK (inventory_write_count = 0)',
  'CHECK (reservation_write_count = 0)',
  'CHECK (fulfillment_write_count = 0)',
  'CHECK (shipment_write_count = 0)',
  'CHECK (commerce_export_write_count = 0)',
], 'Read-only provider and WMS boundary')

includesAll([
  'source_revision text NOT NULL',
  "source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$')",
  'provider_api_version text NOT NULL',
  'normalizer_version text NOT NULL',
  "expires_at <= created_at + interval '30 days'",
], 'Source versioning and retention')

includesAll([
  'FOREIGN KEY (organization_id, integration_account_id)',
  'FOREIGN KEY (organization_id, pipeline_id)',
  'FOREIGN KEY (pipeline_id, product_id)',
  'FOREIGN KEY (pipeline_id, customer_id)',
  'FOREIGN KEY (organization_id, canonical_order_id)',
  'FOREIGN KEY (organization_id, canonical_order_line_id)',
], 'Tenant and canonical authority links')

includesAll([
  'unsupported_reason_code text',
  'promotion_command_receipt_id uuid',
  'promotion_idempotency_key text',
  'promotion_request_hash text',
  'command_receipt_id uuid NOT NULL',
  'idempotency_key text NOT NULL',
  'request_hash text NOT NULL',
], 'Unsupported and idempotent promotion evidence')

includesAll([
  'BEFORE INSERT ON operations_commerce_resolution_decisions',
  'BEFORE UPDATE OR DELETE ON operations_commerce_resolution_decisions',
  'Commerce resolution decisions are append-only',
], 'Resolution decision integrity')

includesAllIn(continuationMigration, [
  'DROP CONSTRAINT IF EXISTS commerce_product_candidates_quantity_valid',
  '-99999999999999.999999 AND 99999999999999.999999',
  "'gcrj',",
  "'operations.commerce_intake_rejection'",
  'CREATE TABLE IF NOT EXISTS operations_commerce_intake_read_intents',
  "resource text NOT NULL CHECK (resource IN ('orders', 'products'))",
  "'fetch', 'fetch-next', 'refresh', 'retry-rejection'",
  "'fetch-products', 'fetch-next-products'",
  "'none', 'candidate', 'rejection', 'continuation'",
  'commerce_intake_read_intents_idempotency_unique',
  'organization_id, integration_account_id, intake_action, idempotency_key',
  'commerce_intake_read_intents_target_valid',
  "target_global_id ~ '^gcoc[0-9]{7}$'",
  "target_global_id ~ '^gcrj[0-9]{7}$'",
  "target_global_id ~ '^gcir[0-9]{7}$'",
  'continuation_id uuid',
  'continuation_cursor_hash text',
  'continuation_row_version bigint',
  'commerce_intake_read_intents_action_target_valid',
  'commerce_intake_read_intents_resource_action_valid',
  "intake_action IN ('fetch-next', 'fetch-next-products')",
  "'prepared', 'reading', 'captured', 'staged', 'uncertain', 'expired'",
  'provider_attempt_id uuid',
  'lease_token uuid',
  'lease_expires_at timestamptz',
  'response_ciphertext bytea',
  'response_iv bytea',
  'response_tag bytea',
  'response_hash text',
  'response_bytes integer',
  'response_encryption_version integer',
  'response_bytes BETWEEN 2 AND 8388608',
  'commerce_intake_read_intents_state_valid',
  "intent_state = 'prepared'",
  "intent_state = 'reading'",
  "intent_state = 'captured'",
  "intent_state = 'staged'",
  "intent_state = 'uncertain'",
  "intent_state = 'expired'",
  'commerce_intake_read_intents_continuation_fkey',
  'commerce_intake_read_intents_active_continuation_unique',
  "intent_state IN ('prepared', 'reading', 'captured')",
  'protect_operations_commerce_intake_read_intent',
  'Commerce intake read intent identity is immutable',
  'Commerce intake read intent update requires the next row version',
  'Invalid commerce intake read intent transition',
  'provider-read identity created before a commerce API call',
], 'Durable provider-read intent')

const readIntentProtection = sqlSection(
  continuationMigration,
  'CREATE OR REPLACE FUNCTION protect_operations_commerce_intake_read_intent()',
  'DROP TRIGGER IF EXISTS protect_operations_commerce_intake_read_intent',
  'Provider-read intent protection',
)
includesAllIn(readIntentProtection, [
  "NEW.intent_state <> 'prepared'",
  'NEW.staged_run_id IS NOT NULL',
  'NEW.row_version <> 0',
  'must begin prepared at row version zero',
  "OLD.intent_state = 'prepared'",
  "NEW.intent_state IN ('reading', 'expired')",
  "OLD.intent_state = 'reading'",
  "NEW.intent_state IN ('captured', 'uncertain')",
  "OLD.intent_state = 'captured'",
  "NEW.intent_state IN ('staged', 'expired')",
  "NEW.intent_state = 'reading'",
  "attempt_action <> 'commerce.intake.read'",
  'attempt_lease_token IS DISTINCT FROM NEW.lease_token',
  "NEW.intent_state IN ('captured', 'uncertain')",
  "attempt_state <> 'succeeded'",
  "attempt_state <> 'unknown'",
  "NEW.intent_state = 'staged'",
  'run.id = NEW.staged_run_id',
  'run_provider_attempt_id IS DISTINCT FROM NEW.provider_attempt_id',
  'run_provider <> NEW.provider',
  'run_credential_version <> NEW.credential_version',
  'run_idempotency_key <> NEW.idempotency_key',
  'run_window_start IS DISTINCT FROM NEW.window_start',
  'run_window_end IS DISTINCT FROM NEW.window_end',
  "NEW.resource = 'orders'",
  "run_resource <> 'products_and_orders'",
  "NEW.resource = 'products'",
  "run_resource <> 'products'",
  'Commerce intake staged run must match its provider-read intent',
], 'Provider-read intent transition integrity')

for (const forbidden of [
  'response_payload jsonb',
  'response_payload text',
  'response_json jsonb',
  'provider_response jsonb',
]) {
  assert.ok(
    !continuationMigration.toLowerCase().includes(forbidden),
    `Provider read evidence must not persist plaintext ${forbidden}`,
  )
}

includesAllIn(continuationMigration, [
  'CREATE TABLE IF NOT EXISTS operations_commerce_intake_continuations',
  "resource text NOT NULL DEFAULT 'orders'",
  "CHECK (resource IN ('orders', 'products'))",
  'cursor_ciphertext bytea',
  'cursor_iv bytea',
  'cursor_tag bytea',
  "cursor_state = 'available'",
  "cursor_state = 'consumed'",
  'consumed_by_run_id uuid',
  'session_id uuid NOT NULL',
  'batch_number integer NOT NULL',
  "NEW.resource = 'orders'",
  "run_resource <> 'products_and_orders'",
  "NEW.resource = 'products'",
  "run_resource <> 'products'",
  'previous_resource <> NEW.resource',
  'Commerce intake continuation batch lineage is invalid',
  'Commerce intake continuation identity is immutable',
  'Commerce intake continuation update requires the next row version',
  'Invalid commerce intake continuation transition',
  'never a durable provider sync cursor',
], 'Resource-scoped continuation')

const continuationProtection = sqlSection(
  continuationMigration,
  'CREATE OR REPLACE FUNCTION protect_operations_commerce_intake_continuation()',
  'DROP TRIGGER IF EXISTS protect_operations_commerce_intake_continuation',
  'Commerce continuation protection',
)
includesAllIn(continuationProtection, [
  "NEW.cursor_state NOT IN ('available', 'exhausted')",
  'NEW.row_version <> 0',
  'must begin available or exhausted at row version zero',
  'run.window_start, run.window_end',
  'run_window_start IS DISTINCT FROM NEW.window_start',
  'run_window_end IS DISTINCT FROM NEW.window_end',
  'previous_resource <> NEW.resource',
  'previous_consumed_by_run_id <> NEW.run_id',
], 'Continuation run and lineage integrity')
assert.ok(
  !continuationProtection.includes('NEW.retry_run_id'),
  'Continuation protection must not reference rejection-only retry fields',
)

includesAllIn(continuationMigration, [
  'CREATE TABLE IF NOT EXISTS operations_commerce_intake_rejections',
  "resource_type text NOT NULL CHECK (resource_type IN ('order', 'product'))",
  "'open', 'retried', 'excluded', 'superseded'",
  'commerce_intake_rejections_registry_fkey',
  'commerce_intake_rejections_run_fkey',
  'commerce_intake_rejections_retry_run_fkey',
  'commerce_intake_rejections_receipt_fkey',
  'commerce_intake_rejections_run_identity_unique',
  "disposition = 'open'",
  "disposition = 'retried'",
  "disposition = 'excluded'",
  "disposition = 'superseded'",
  "NEW.resource_type = 'order'",
  "run_resource <> 'products_and_orders'",
  "NEW.resource_type = 'product'",
  "run_resource <> 'products'",
  'Commerce intake rejection identity is immutable',
  'Commerce intake rejection update requires the next row version',
  'Invalid commerce intake rejection transition',
  'exact-retry or audited exclusion dispositions',
], 'First-class normalization rejection')

const rejectionProtection = sqlSection(
  continuationMigration,
  'CREATE OR REPLACE FUNCTION protect_operations_commerce_intake_rejection()',
  'DROP TRIGGER IF EXISTS protect_operations_commerce_intake_rejection',
  'Commerce rejection protection',
)
includesAllIn(rejectionProtection, [
  "NEW.disposition <> 'open'",
  'NEW.retry_run_id IS NOT NULL',
  'NEW.exclusion_reason IS NOT NULL',
  'NEW.disposition_receipt_id IS NOT NULL',
  'NEW.row_version <> 0',
  'must begin open at row version zero',
  "NEW.disposition = 'retried'",
  'replacement.id <> NEW.id',
  'candidate.external_order_id = NEW.external_id',
  'candidate.external_product_id = NEW.external_id',
  'candidate.external_variant_id = NEW.external_id',
  'replacement.external_id = NEW.external_id',
  'Commerce intake retry run must contain exact target evidence',
], 'Rejection retry evidence integrity')

const rejectionRetryProtection = sqlSection(
  rejectionProtection,
  "IF NEW.disposition = 'retried' THEN",
  'RETURN NEW;',
  'Retried rejection protection',
)
includesAllIn(rejectionRetryProtection, [
  'NEW.retry_run_id = NEW.run_id',
  'replacement.id <> NEW.id',
  'Commerce intake retry run must contain exact target evidence',
], 'Retried rejection distinct-run evidence')

for (const mutation of [
  'INSERT INTO operations_commerce_sync_cursors',
  'UPDATE operations_commerce_sync_cursors',
  'DELETE FROM operations_commerce_sync_cursors',
]) {
  assert.ok(
    !continuationMigration.includes(mutation),
    'Continuation schema must not mutate durable commerce sync cursors',
  )
}

console.log('commerce normalization schema contracts passed')
