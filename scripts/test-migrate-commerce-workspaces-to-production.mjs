#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  CONFIRMED_OWNER_EMAIL,
  DATASET_ORDER,
  FORBIDDEN_ALIAS_USER,
  MANIFEST_FORMAT,
  SCRIPT_VERSION,
  SOURCE_DATABASE_IDENTITY,
  TARGET_SCOPE_COLUMN,
  TARGET_DATABASE_IDENTITY,
  WORKSPACES,
  buildCredentialFreePlaceholder,
  canonicalJson,
  datasetCounts,
  digest,
  manifestDigest,
  parseArguments,
  sanitizeJson,
  sourceSnapshotProjection,
  topologicalRows,
  validateDatasetClosure,
} from './migrate-commerce-workspaces-to-production.mjs'

assert.equal(SOURCE_DATABASE_IDENTITY, '750aa268-0e31-4065-a99c-4016e4d4fab1')
assert.equal(TARGET_DATABASE_IDENTITY, '0474a18c-649c-491b-bea1-7da006d21d81')
assert.equal(CONFIRMED_OWNER_EMAIL, 'jarrett@suburbiasandwichco.com')
assert.equal(FORBIDDEN_ALIAS_USER, 'jarrett@bposupplychain.com')
assert.equal(TARGET_SCOPE_COLUMN.crm_contacts, 'pipeline_id')
assert.equal(TARGET_SCOPE_COLUMN.crm_organizations, 'pipeline_id')
assert.equal(TARGET_SCOPE_COLUMN.operations_external_identifiers, 'organization_id')
assert.equal(TARGET_SCOPE_COLUMN.operations_integration_accounts, 'organization_id')

const planArgs = parseArguments([
  'plan',
  '--actor', CONFIRMED_OWNER_EMAIL,
  '--images', 'current',
  '--output', '/tmp/example-plan.json',
])
assert.equal(planArgs.command, 'plan')
assert.equal(planArgs.images, 'current')
assert.equal(planArgs.actor, CONFIRMED_OWNER_EMAIL)

const exampleDigest = 'a'.repeat(64)
const applyArgs = parseArguments([
  'apply',
  '--actor', CONFIRMED_OWNER_EMAIL,
  '--manifest', '/tmp/example-plan.json',
  '--confirm-digest', exampleDigest,
  '--mapping-output', '/tmp/example-mapping.json',
])
assert.equal(applyArgs.command, 'apply')
assert.equal(applyArgs.confirmDigest, exampleDigest)

assert.throws(() => parseArguments([
  'plan', '--actor', FORBIDDEN_ALIAS_USER,
  '--images', 'current', '--output', '/tmp/no.json',
]), /confirmed production owner/u)
assert.throws(() => parseArguments([
  'plan', '--actor', CONFIRMED_OWNER_EMAIL,
  '--images', 'all', '--output', '/tmp/no.json',
]), /current/u)
assert.throws(() => parseArguments([
  'apply', '--actor', CONFIRMED_OWNER_EMAIL,
  '--manifest', '/tmp/no.json', '--confirm-digest', 'bad',
  '--mapping-output', '/tmp/map.json',
]), /SHA-256/u)

const canonicalA = canonicalJson({ z: 1, a: Buffer.from('safe') })
const canonicalB = canonicalJson({ a: Buffer.from('safe'), z: 1 })
assert.equal(canonicalA, canonicalB)
assert.equal(digest({ z: 1, a: 2 }), digest({ a: 2, z: 1 }))

const manifest = {
  format: MANIFEST_FORMAT,
  scriptVersion: SCRIPT_VERSION,
  createdAt: '2026-09-04T00:00:00.000Z',
  applyReady: false,
}
manifest.manifestDigest = manifestDigest(manifest)
assert.equal(manifest.manifestDigest.length, 64)
const changed = structuredClone(manifest)
changed.applyReady = true
assert.notEqual(manifestDigest(changed), manifest.manifestDigest)

const replacements = new Map([
  ['source-org', 'target-org'],
  ['gia-source', 'gia-target'],
])
assert.deepEqual(sanitizeJson({
  organizationId: 'source-org',
  sourceKey: 'commerce-catalog:gia-source:item',
  suiteCrmInbound: { id: 'secret-ish-id' },
  nested: {
    suitecrmId: 'native-id',
    candidateGlobalId: 'candidate-id',
    kept: 'source-org/value',
  },
}, replacements), {
  organizationId: 'target-org',
  sourceKey: 'commerce-catalog:gia-target:item',
  nested: { kept: 'target-org/value' },
})

assert.deepEqual(
  topologicalRows([
    { id: 'child', parent_id: 'root' },
    { id: 'root', parent_id: null },
    { id: 'leaf', parent_id: 'child' },
  ], 'parent_id', 'fixture').map((row) => row.id),
  ['root', 'child', 'leaf'],
)
assert.throws(() => topologicalRows([
  { id: 'a', parent_id: 'b' },
  { id: 'b', parent_id: 'a' },
], 'parent_id', 'fixture'), /cycle/u)
assert.throws(() => topologicalRows([
  { id: 'a', parent_id: 'missing' },
], 'parent_id', 'fixture'), /unselected parent/u)

const emptyDataset = Object.fromEntries(DATASET_ORDER.map((table) => [table, []]))
assert.equal(validateDatasetClosure(emptyDataset, WORKSPACES[0]), true)
assert.throws(() => validateDatasetClosure({
  ...emptyDataset,
  crm_products: [{ id: 'product', category_id: 'missing' }],
}, WORKSPACES[0]), /crm_products\.category_id references an unselected row/u)

const placeholder = buildCredentialFreePlaceholder({
  integration_type: 'commerce',
  provider: 'shopify',
  environment: 'sandbox',
  display_name: 'Example',
  configuration: { shopDomain: 'must-not-copy.example' },
  external_account_id: 'gid://provider/secret-bound-identity',
  credential_reference: 'must-not-copy',
}, {
  id: '3de8e0a7-9b39-4be2-8b53-ce07a421cc18',
  globalId: 'gia0000001',
  organizationId: '62140295-6680-4102-8f6c-e7bf8d001f39',
}, CONFIRMED_OWNER_EMAIL)
assert.equal(placeholder.status, 'disabled')
assert.deepEqual(placeholder.configuration, {})
assert.equal(placeholder.external_account_id, null)
assert.equal(placeholder.credential_reference, null)
assert.equal(placeholder.commerce_credential_generation, 0)
assert.equal(placeholder.receipt_intake_enabled, false)

assert.deepEqual(WORKSPACES.map((workspace) => workspace.key), [
  'ag-alchemy', 'french-florist', 'test-pro-bakery-bites',
])
assert.deepEqual(WORKSPACES.map((workspace) => workspace.target.organizationId), [
  '33785418-9927-4e10-a492-d3a44b9b6f21',
  '3b9ceada-a4ff-4363-8e78-6069dee76328',
  'c8fcf491-cf8c-469a-b03c-0026a762752c',
])
const accounts = WORKSPACES.flatMap((workspace) => workspace.source.accounts)
assert.equal(accounts.length, 4)
assert.equal(accounts.filter((account) => account.environment === 'sandbox').length, 2)
assert.ok(accounts
  .filter((account) => account.environment === 'sandbox')
  .every((account) => account.reconnectEligible === false))
assert.ok(accounts
  .filter((account) => account.environment === 'production')
  .every((account) => account.reconnectEligible === true))
assert.ok(accounts.every((account) => /^[a-f0-9]{64}$/u.test(account.externalAccountIdSha256)))

const imageBytes = Buffer.from('representative image bytes')
const projected = sourceSnapshotProjection(Object.fromEntries(
  [
    'workspace_organization_preferences',
    'operations_shipping_scopes',
    'crm_product_categories',
    'operations_integration_accounts',
    'crm_organizations',
    'crm_contacts',
    'crm_contact_source_aliases',
    'crm_products',
    'operations_product_mappings',
    'operations_product_channel_states',
    'operations_warehouses',
    'operations_locations',
    'operations_packaging_materials',
    'operations_packaging_material_stock',
    'operations_product_pack_profiles',
    'operations_product_pack_profile_versions',
    'operations_product_pack_relationships',
    'operations_approved_pack_recipes',
    'operations_product_barcodes',
    'operations_product_package_profiles',
    'operations_commerce_variant_pack_mappings',
    'operations_external_identifiers',
    'crm_product_image_assets',
  ].map((table) => [table, table === 'crm_product_image_assets'
    ? [{ id: 'image', content_bytes: imageBytes, content_sha256: digest('different representation') }]
    : []]),
))
assert.equal(projected.crm_product_image_assets[0].content_bytes, undefined)
assert.equal(datasetCounts(projected).crm_product_image_assets, 1)

const source = fs.readFileSync(new URL('./migrate-commerce-workspaces-to-production.mjs', import.meta.url), 'utf8')
for (const forbiddenSql of [
  'SELECT * FROM operations_integration_accounts',
  'FROM operations_commerce_credentials',
  'JOIN operations_commerce_credentials',
  'FROM operations_commerce_sync_cursors',
  'FROM operations_orders',
  'FROM sync_outbox',
]) assert.equal(source.includes(forbiddenSql), false, `forbidden source read: ${forbiddenSql}`)

for (const requiredSanitization of [
  "encode(digest(coalesce(external_account_id, ''), 'sha256'), 'hex')",
  "'dimension_confirmed_by'",
  "'rated_outer_dimension_confirmed_by'",
  'currency_code = EXCLUDED.currency_code',
  "AND mapping_purpose = 'catalog'",
  'mapping: existing.payload.mapping',
  'has a migration receipt from a different source state',
]) assert.ok(source.includes(requiredSanitization), `missing sanitization contract: ${requiredSanitization}`)

for (const required of [
  'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  'BEGIN ISOLATION LEVEL SERIALIZABLE',
  'pg_advisory_xact_lock',
  'operations_commerce_store_sync_is_running',
  'purge_operations_commerce_intake_read_payloads',
  'convert_operations_commerce_inventory_legacy_captures',
  'purge_operations_commerce_inventory_observation_aliases',
  'purge_operations_commerce_inventory_level_evidence',
  'response_purged_at',
  'history_exclusion_code',
  "status: 'disabled'",
  'credential_reference: null',
  'external_account_id: null',
  'receipt_intake_enabled: false',
]) assert.ok(source.includes(required), `missing fail-closed contract: ${required}`)

console.log('commerce workspace production migration contract: PASS')
