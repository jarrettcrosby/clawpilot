#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function section(source, start, end) {
  const startIndex = source.indexOf(start)
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`)
  return source.slice(startIndex, endIndex)
}

const migration = read(
  'db/migrations/0168_operations_commerce_verified_account_status.sql',
)
assert.match(
  migration,
  /UPDATE operations_integration_accounts account[\s\S]+SET status = 'active'/,
)
assert.match(migration, /account\.integration_type = 'commerce'/)
assert.match(migration, /account\.status = 'disabled'/)
assert.match(
  migration,
  /credential\.external_account_id = account\.external_account_id/,
)
assert.match(
  migration,
  /credential\.credential_version\s*=\s*account\.commerce_credential_generation/,
)
assert.match(migration, /credential\.verification_status = 'verified'/)
assert.doesNotMatch(migration, /receipt_intake_enabled/)
assert.doesNotMatch(
  migration,
  /operations_activation_scopes|operations_commerce_external_effect/,
)

const persistence = read('app_src/lib/persistence/commerceIntegrations.ts')
const service = read('app_src/lib/integrations/commerceIntegrations.ts')
const writeCredential = section(
  persistence,
  'export async function writeCommerceCredentialInPostgres',
  'export async function markCommerceCredentialVerificationInPostgres',
)
assert.match(
  writeCredential,
  /VALUES \([\s\S]+?'commerce'[\s\S]+?'active'/,
  'A provider-verified connect must create an active read/callback account',
)
assert.match(
  writeCredential,
  /ON CONFLICT[\s\S]+?status = 'active'/,
  'A provider-verified credential rotation must restore active status',
)
assert.match(writeCredential, /receipt_intake_enabled = false/)
assert.match(writeCredential, /verification_status = 'verified'/)
assert.doesNotMatch(writeCredential, /receipt_intake_enabled\s*=\s*true/)

const markVerification = section(
  persistence,
  'export async function markCommerceCredentialVerificationInPostgres',
  'export async function setCommerceIntegrationEnabledInPostgres',
)
assert.match(
  markVerification,
  /WHEN \$3::text IS NOT NULL THEN 'error'\s+ELSE 'active'/,
  'Successful verification must activate read/callback eligibility and an authoritative failure must fail closed',
)
assert.match(
  markVerification,
  /WHEN \$3::text IS NULL THEN 'verified'\s+ELSE 'failed'/,
)
assert.match(
  markVerification,
  /WHEN \$3::text IS NOT NULL OR \$7::boolean THEN false/,
)
assert.doesNotMatch(markVerification, /receipt_intake_enabled\s*=\s*true/)
assert.match(
  service,
  /Faire does not use Shopify signed-receipt intake; its verified provider-read connection remains active independently/,
)
assert.doesNotMatch(
  service,
  /verified connection must remain disabled/,
  'Faire receipt-intake messaging must not disable a verified read-eligible account',
)

const receiptPolicy = section(
  persistence,
  'export async function setCommerceIntegrationEnabledInPostgres',
  'export async function disconnectCommerceCredentialInPostgres',
)
assert.match(receiptPolicy, /SET receipt_intake_enabled = \$3::boolean/)
assert.doesNotMatch(receiptPolicy, /SET\s+status\s*=/)

const disconnect = section(
  persistence,
  'export async function disconnectCommerceCredentialInPostgres',
  'export async function recordCommerceProviderAttemptInPostgres',
)
assert.match(disconnect, /DELETE FROM operations_commerce_credentials/)
assert.match(disconnect, /SET status = 'disabled'/)
assert.match(disconnect, /receipt_intake_enabled = false/)

const externalEffects = read(
  'app_src/lib/persistence/commerceExternalEffects.ts',
)
assert.match(externalEffects, /desired_mode = 'active'/)
assert.match(externalEffects, /activation\.state = 'active'/)
assert.match(
  externalEffects,
  /account\.commerce_credential_generation\s*=\s*\$\{alias\}\.credential_generation/,
)
assert.match(
  externalEffects,
  /credential\.verification_status = 'verified'/,
)

const establishment = read(
  'scripts/establish-ag-alchemy-development.mjs',
)
assert.match(
  establishment,
  /'shopify', 'commerce', 'sandbox'[\s\S]+?'active', \$4::jsonb/,
)
assert.match(establishment, /target\.account\.status !== 'active'/)
assert.match(establishment, /SET status = 'disabled', credential_reference = NULL/)

const contract = read('docs/modules/distributed-operations.md')
  .replace(/\s+/g, ' ')
for (const text of [
  'Migration `0168`',
  'verified provider reads and registered callback computation',
  '`receipt_intake_enabled` remains independent',
  'does not authorize any provider mutation',
]) {
  assert.ok(contract.includes(text), `Distributed Operations contract missing: ${text}`)
}

console.log('PASS verified commerce account-status contracts')
