#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function migrationSql(filename) {
  return readFileSync(
    fileURLToPath(
      new URL(`../db/migrations/${filename}`, import.meta.url),
    ),
    'utf8',
  )
}

const canonicalMigration =
  migrationSql('0159_operations_shopify_receipt_and_carrier_authority.sql')
const migration = migrationSql('0165_shopify_store_entity_readiness.sql')
const readiness =
  migration.match(
    /CREATE OR REPLACE FUNCTION\s+operations_shopify_carrier_service_config_is_ready[\s\S]+?\n\$\$;/,
  )?.[0] || ''
const canonicalReadiness =
  canonicalMigration.match(
    /CREATE OR REPLACE FUNCTION\s+operations_shopify_carrier_service_config_is_ready[\s\S]+?\n\$\$;/,
  )?.[0] || ''

function normalizedSql(value) {
  return value.replace(/\s+/g, ' ').trim()
}

const readinessWithoutStoreEntity = readiness.replace(
  /\s+AND length\(\s*btrim\(account\.configuration ->> 'accountName'\)\s*\)\s+BETWEEN 1 AND 255\s+AND btrim\(account\.configuration ->> 'accountName'\)\s*!~ '\[\[:cntrl:\]\]'/,
  '',
)

assert.equal(
  normalizedSql(readinessWithoutStoreEntity),
  normalizedSql(canonicalReadiness),
  '0165 must retain the canonical 0159 readiness body unchanged except for the store-entity fence.',
)

assert.match(
  readiness,
  /length\(\s*btrim\(account\.configuration ->> 'accountName'\)\s*\)\s+BETWEEN 1 AND 255/,
  'CarrierService readiness must require a bounded provider store entity.',
)
assert.match(
  readiness,
  /btrim\(account\.configuration ->> 'accountName'\)\s*!~ '\[\[:cntrl:\]\]'/,
  'CarrierService readiness must reject control characters in the store entity.',
)
assert.doesNotMatch(
  readiness,
  /account\.display_name|account\.external_account_id|COALESCE\s*\(/,
  'CarrierService store identity must not fall back to a platform or editable connection label.',
)

for (const retainedFence of [
  "account.integration_type = 'commerce'",
  "account.provider = 'shopify'",
  "account.environment = 'sandbox'",
  "account.status <> 'error'",
  'account.commerce_credential_generation',
  "credential.verification_status = 'verified'",
  'activation.revision = config.activation_revision',
  "warehouse.status = 'active'",
  'material.row_version',
  'stock.on_hand_quantity',
  "selected.carrier_provider = 'ups_rest'",
  "selected.carrier_provider = 'fedex_rest'",
]) {
  assert.ok(
    readiness.includes(retainedFence),
    `store-entity readiness migration lost ${retainedFence}`,
  )
}

assert.doesNotMatch(
  migration,
  /\bDROP (?:TABLE|COLUMN|CONSTRAINT|FUNCTION)\b/,
  'Store-entity readiness must remain an additive predicate replacement.',
)

console.log(JSON.stringify({
  ok: true,
  suite: 'shopify-store-entity-readiness',
  migration: '0165_shopify_store_entity_readiness.sql',
}, null, 2))
