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

const legacyAuthorization =
  migrationSql('0150_operations_shopify_carrier_service_mutation_authorization.sql')
const activeAuthorization =
  migrationSql('0156_operations_shopify_carrier_service_active_authorization.sql')
const migration =
  migrationSql('0159_operations_shopify_receipt_and_carrier_authority.sql')

assert.match(
  migration,
  /receipt_intake_enabled boolean NOT NULL DEFAULT false/,
  'receipt intake must be an independent non-null fail-closed switch',
)
assert.match(
  migration,
  /integration_type = 'commerce'[\s\S]+provider = 'shopify'[\s\S]+status = 'active'/,
  'legacy receipt intake must be seeded only for active Shopify commerce accounts',
)

const readiness =
  migration.match(
    /CREATE OR REPLACE FUNCTION\s+operations_shopify_carrier_service_config_is_ready[\s\S]+?\n\$\$;/,
  )?.[0] || ''
assert.match(readiness, /account\.status <> 'error'/)
assert.doesNotMatch(
  readiness,
  /receipt_intake_enabled|(?:^|\s)account\.status = 'active'/m,
  'CarrierService callback readiness must not depend on signed receipts or generic active status',
)
assert.match(
  readiness,
  /activation\.revision = config\.activation_revision/,
  'callback readiness must reject stale activation/config revisions',
)
for (const requiredReadinessFence of [
  'credential.verification_status',
  'material.row_version',
  'rated_outer_length_mm',
  'rated_outer_width_mm',
  'rated_outer_height_mm',
  'stock.on_hand_quantity',
  'carrier_credential.verification_status',
  "selected.carrier_provider = 'ups_rest'",
  "selected.carrier_provider = 'fedex_rest'",
]) {
  assert.ok(
    readiness.includes(requiredReadinessFence),
    `callback readiness lost ${requiredReadinessFence}`,
  )
}

const authorization =
  migration.match(
    /CREATE OR REPLACE FUNCTION\s+protect_ops_shopify_cs_mut_authorization\(\)[\s\S]+?\n\$\$;/,
  )?.[0] || ''
assert.match(
  authorization,
  /operations_shopify_carrier_service_actor_can_authorize/,
)
assert.match(
  authorization,
  /account_status IS DISTINCT FROM 'active'[\s\S]+account_status IS DISTINCT FROM 'disabled'/,
)
assert.match(
  authorization,
  /current_activation_state IS DISTINCT FROM 'shadow'/,
)
assert.match(
  authorization,
  /current_activation_revision IS DISTINCT FROM\s+NEW\.provider_write_activation_revision/,
)
assert.match(
  authorization,
  /credential_status IS DISTINCT FROM 'verified'/,
)
assert.match(
  authorization,
  /effect_provider_write_count IS DISTINCT FROM 0/,
)
assert.match(
  authorization,
  /prior\.provider_write_activation_revision IS NOT NULL/,
  'authorization must preserve the one-exact-mutation fence',
)
assert.match(
  authorization,
  /NEW\.operation = 'create'[\s\S]+NEW\.account_environment IS DISTINCT FROM 'sandbox'/,
  'new registration must remain sandbox-only',
)

const claim =
  migration.match(
    /CREATE OR REPLACE FUNCTION\s+protect_ops_shopify_cs_mut_attempt\(\)[\s\S]+?\n\$\$;/,
  )?.[0] || ''
assert.match(claim, /authorization_expires_at <= now\(\)/)
assert.match(
  claim,
  /account_status IS DISTINCT FROM 'active'[\s\S]+account_status IS DISTINCT FROM 'disabled'/,
)
assert.match(claim, /credential_status IS DISTINCT FROM 'verified'/)
assert.match(
  claim,
  /current_activation_state IS DISTINCT FROM 'shadow'/,
)
assert.match(
  claim,
  /current_activation_revision IS DISTINCT FROM\s+authorization_provider_write_activation_revision/,
)
assert.match(
  claim,
  /config_row_version IS DISTINCT FROM authorization_row_version/,
)

const finalization =
  migration.match(
    /CREATE OR REPLACE FUNCTION\s+protect_ops_shopify_cs_config_mut_link\(\)[\s\S]+?\n\$\$;/,
  )?.[0] || ''
assert.match(
  finalization,
  /outcome_state IS DISTINCT FROM 'succeeded'/,
)
assert.match(
  finalization,
  /outcome_provider_write_count IS DISTINCT FROM 1/,
)
assert.match(
  finalization,
  /resolution_disposition IS DISTINCT FROM 'confirmed_applied'/,
)
assert.match(
  finalization,
  /config_row_version IS DISTINCT FROM NEW\.from_row_version/,
)
assert.doesNotMatch(
  finalization,
  /receipt_intake_enabled|current_activation_(?:state|revision)|operations_commerce_credentials/,
  'post-provider local finalization must survive later mutable-state drift',
)

assert.match(
  legacyAuthorization,
  /expires_at <= authorized_at \+ interval '5 minutes'/,
  'the immutable authorization expiry constraint must remain in force',
)
assert.match(
  activeAuthorization,
  /provider_write_activation_revision integer/,
  'the exact resource-scoped revision column must already exist',
)
assert.doesNotMatch(
  migration,
  /\bDROP (?:TABLE|COLUMN|CONSTRAINT)\b/,
  '0159 must remain additive and preserve the immutable evidence schema',
)

console.log(JSON.stringify({
  ok: true,
  suite: 'shopify-carrier-service-receipt-authority',
  migration:
    '0159_operations_shopify_receipt_and_carrier_authority.sql',
}, null, 2))
