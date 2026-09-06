#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  APPROVED_TARGETS,
  CONFIRMED_OPERATOR_EMAIL,
  PLAN_FORMAT,
  PRODUCTION_DATABASE_IDENTITY,
  PRODUCTION_RAILWAY_ENVIRONMENT_ID,
  PRODUCTION_RAILWAY_PROJECT_ID,
  RECEIPT_FORMAT,
  SCRIPT_VERSION,
  assertRuntimeEnvironment,
  canonicalJson,
  computeDeletionOrder,
  databaseEndpointFingerprint,
  deriveOrganizationOwnership,
  digest,
  manifestDigest,
  parseArguments,
  quoteIdentifier,
  validateTargetArguments,
} from './retire-workspace-tenants.mjs'

const exactTargets = APPROVED_TARGETS.flatMap((target) => [
  '--target', `${target.organizationId}|${target.referenceCode}|${target.name}`,
])
const common = [
  '--actor', CONFIRMED_OPERATOR_EMAIL,
  '--environment', 'production',
  '--railway-project-id', PRODUCTION_RAILWAY_PROJECT_ID,
  '--railway-environment-id', PRODUCTION_RAILWAY_ENVIRONMENT_ID,
  ...exactTargets,
]

assert.equal(SCRIPT_VERSION, 'workspace-tenant-retirement-v2')
assert.equal(PLAN_FORMAT, 'clawpilot-workspace-tenant-retirement-plan-v2')
assert.equal(RECEIPT_FORMAT, 'clawpilot-workspace-tenant-retirement-receipt-v2')
assert.equal(PRODUCTION_DATABASE_IDENTITY, '0474a18c-649c-491b-bea1-7da006d21d81')
assert.deepEqual(APPROVED_TARGETS.map((target) => ({
  organizationId: target.organizationId,
  referenceCode: target.referenceCode,
  name: target.name,
  organizationType: target.organizationType,
  parentId: target.parentId,
})), [
  {
    organizationId: '33785418-9927-4e10-a492-d3a44b9b6f21',
    referenceCode: 'ga42g1438l4j2s',
    name: 'AG Alchemy, LLC',
    organizationType: 'member',
    parentId: null,
  },
  {
    organizationId: '3b9ceada-a4ff-4363-8e78-6069dee76328',
    referenceCode: 'gakrnoh15krp9n',
    name: 'French Florist',
    organizationType: 'member',
    parentId: null,
  },
  {
    organizationId: 'c8fcf491-cf8c-469a-b03c-0026a762752c',
    referenceCode: 'gac10cb46e3rpl',
    name: 'Test Pro Bakery Bites',
    organizationType: 'member',
    parentId: null,
  },
])

const defaultPlan = parseArguments([...common, '--output', '/tmp/retirement-plan.json'])
assert.equal(defaultPlan.command, 'plan')
assert.equal(defaultPlan.actor, CONFIRMED_OPERATOR_EMAIL)
assert.equal(defaultPlan.targets.length, 3)

const shuffledTargetValues = [...APPROVED_TARGETS].reverse().map((target) => (
  `${target.organizationId}|${target.referenceCode}|${target.name}`
))
assert.deepEqual(validateTargetArguments(shuffledTargetValues), APPROVED_TARGETS)
assert.throws(
  () => validateTargetArguments(shuffledTargetValues.slice(1)),
  /Exactly 3 --target values/u,
)
assert.throws(
  () => validateTargetArguments([
    ...shuffledTargetValues.slice(0, 2),
    `${APPROVED_TARGETS[0].organizationId}|${APPROVED_TARGETS[0].referenceCode}|AG Alchemy`,
  ]),
  /allowlist mismatch|unique/u,
)
assert.throws(
  () => parseArguments([
    ...common.slice(0, -2),
    '--target', '00000000-0000-4000-8000-000000000000|ga000000000000|Wrong',
    '--output', '/tmp/no.json',
  ]),
  /allowlist mismatch/u,
)

const confirmation = 'a'.repeat(64)
const apply = parseArguments([
  'apply', ...common,
  '--manifest', '/tmp/retirement-plan.json',
  '--confirm-digest', confirmation,
  '--receipt-output', '/tmp/retirement-receipt.json',
  '--acknowledge-suitecrm-retained', 'b'.repeat(64),
])
assert.equal(apply.command, 'apply')
assert.equal(apply.confirmDigest, confirmation)
assert.equal(apply.suiteCrmAcknowledgement, 'b'.repeat(64))

const verify = parseArguments([
  'verify', ...common,
  '--manifest', '/tmp/retirement-plan.json',
  '--confirm-digest', confirmation,
])
assert.equal(verify.command, 'verify')
assert.throws(() => parseArguments([
  'apply', ...common,
  '--manifest', '/tmp/retirement-plan.json',
  '--confirm-digest', 'not-a-digest',
  '--receipt-output', '/tmp/receipt.json',
]), /SHA-256/u)
assert.throws(() => parseArguments([
  ...common.map((value) => value === 'production' ? 'development' : value),
  '--output', '/tmp/no.json',
]), /must equal production/u)
assert.throws(() => parseArguments([
  ...common.map((value) => value === CONFIRMED_OPERATOR_EMAIL ? 'other@example.com' : value),
  '--output', '/tmp/no.json',
]), /confirmed production operator/u)

const endpointA = databaseEndpointFingerprint(
  'postgresql://operator:first-secret@database.example.test:5432/clawpilot',
)
const endpointARotated = databaseEndpointFingerprint(
  'postgresql://operator:second-secret@database.example.test:5432/clawpilot',
)
const endpointB = databaseEndpointFingerprint(
  'postgresql://operator:first-secret@database.example.test:5432/clawpilot_other',
)
assert.equal(endpointA, endpointARotated)
assert.notEqual(endpointA, endpointB)
assert.throws(() => databaseEndpointFingerprint('https://example.test/db'), /PostgreSQL/u)

const runtime = {
  DATABASE_URL: 'postgresql://operator:secret@database.example.test:5432/clawpilot',
  RAILWAY_PROJECT_ID: PRODUCTION_RAILWAY_PROJECT_ID,
  RAILWAY_ENVIRONMENT_ID: PRODUCTION_RAILWAY_ENVIRONMENT_ID,
  RAILWAY_ENVIRONMENT_NAME: 'production',
  CLAWPILOT_TENANT_RETIRE_DATABASE_ENDPOINT_SHA256: endpointA,
}
assert.deepEqual(assertRuntimeEnvironment(defaultPlan, runtime), {
  endpointSha256: endpointA,
})
assert.throws(
  () => assertRuntimeEnvironment(defaultPlan, { ...runtime, RAILWAY_ENVIRONMENT_NAME: 'development' }),
  /ENVIRONMENT_NAME must equal production/u,
)
assert.throws(
  () => assertRuntimeEnvironment(defaultPlan, {
    ...runtime,
    CLAWPILOT_TENANT_RETIRE_DATABASE_ENDPOINT_SHA256: endpointB,
  }),
  /reviewed endpoint fingerprint/u,
)

assert.equal(canonicalJson({ z: 1, a: 2 }), canonicalJson({ a: 2, z: 1 }))
assert.equal(digest({ z: 1, a: 2 }), digest({ a: 2, z: 1 }))
const manifest = { format: PLAN_FORMAT, applyReady: false }
manifest.manifestDigest = manifestDigest(manifest)
assert.equal(manifest.manifestDigest.length, 64)
assert.notEqual(manifestDigest({ ...manifest, applyReady: true }), manifest.manifestDigest)
assert.equal(quoteIdentifier('safe"name'), '"safe""name"')
assert.throws(() => quoteIdentifier('bad\u0000name'), /Unsafe SQL identifier/u)

assert.deepEqual(
  computeDeletionOrder(
    ['workspace_organizations', 'pipeline_spaces', 'crm_organizations'],
    [
      ['pipeline_spaces', 'workspace_organizations'],
      ['crm_organizations', 'pipeline_spaces'],
    ],
  ).ordered.map((relation) => relation.name),
  ['crm_organizations', 'pipeline_spaces', 'workspace_organizations'],
)

const ownershipRelations = [
  {
    oid: '1', schema: 'public', name: 'workspace_organizations', kind: 'r',
    columns: [{ name: 'id', typeOid: '2950' }, { name: 'parent_id', typeOid: '2950' }],
  },
  {
    oid: '2', schema: 'public', name: 'rate_accounts', kind: 'r',
    columns: [
      { name: 'id', typeOid: '2950' },
      { name: 'platform_organization_id', typeOid: '2950' },
      { name: 'account_owner_organization_id', typeOid: '2950' },
    ],
  },
  {
    oid: '3', schema: 'public', name: 'executions', kind: 'r',
    columns: [{ name: 'executing_organization_id', typeOid: '2950' }],
  },
]
const ownershipForeignKeys = [
  {
    name: 'rate_platform_fk', child_oid: '2', parent_oid: '1',
    childColumns: ['platform_organization_id'], parentColumns: ['id'],
  },
  {
    name: 'rate_owner_fk', child_oid: '2', parent_oid: '1',
    childColumns: ['account_owner_organization_id'], parentColumns: ['id'],
  },
  {
    name: 'execution_owner_fk', child_oid: '3', parent_oid: '2',
    childColumns: ['executing_organization_id'], parentColumns: ['account_owner_organization_id'],
  },
]
const ownership = deriveOrganizationOwnership(ownershipRelations, ownershipForeignKeys)
assert.deepEqual(ownership.unclassified, [])
assert.deepEqual(ownership.roles.map(({ table, column }) => `${table}.${column}`), [
  'executions.executing_organization_id',
  'rate_accounts.account_owner_organization_id',
  'rate_accounts.platform_organization_id',
])
assert.deepEqual(
  computeDeletionOrder(['a', 'b'], [['a', 'b'], ['b', 'a']]).cycles,
  ['a', 'b'],
)

const source = fs.readFileSync(new URL('./retire-workspace-tenants.mjs', import.meta.url), 'utf8')
const migration = fs.readFileSync(
  new URL('../db/migrations/0360_workspace_tenant_retirement_receipts.sql', import.meta.url),
  'utf8',
)
for (const expected of [
  'BEGIN ISOLATION LEVEL SERIALIZABLE',
  'pg_advisory_xact_lock',
  'workspace_tenant_retirement_scope',
  'pg_catalog.pg_constraint',
  'IN ACCESS EXCLUSIVE MODE',
  'lockCatalogDigest',
  'unclassifiedOrganizationRoles',
  'Committed retirement receipt digest is invalid',
  'DISABLE TRIGGER',
  'Post-delete relational absence verification failed',
  'postCommitVerification',
  "status = 'retired'",
  "action: 'not_called'",
]) {
  assert.ok(source.includes(expected), `Missing safety invariant in source: ${expected}`)
}
for (const forbidden of [
  'session_replication_role',
  'DISABLE TRIGGER ALL',
  'fetch(',
  'axios',
]) {
  assert.equal(source.includes(forbidden), false, `Forbidden retirement behavior: ${forbidden}`)
}
assert.match(migration, /workspace_tenant_retirement_receipts/u)
assert.match(migration, /BEFORE UPDATE OR DELETE/u)
assert.match(migration, /locked_relations/u)
assert.match(migration, /deleted_counts/u)
assert.match(migration, /retirement receipts are immutable/u)
assert.doesNotMatch(migration, /REFERENCES\s+workspace_organizations/iu)

process.stdout.write('tenant retirement unit/static safety tests passed\n')
