#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function section(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `${label} is missing ${startMarker}`)
  const end = endMarker
    ? source.indexOf(endMarker, start + startMarker.length)
    : source.length
  assert.notEqual(end, -1, `${label} is missing ${endMarker}`)
  return source.slice(start, end)
}

function includes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} is missing ${fragment}`)
  }
}

function loadPersistence() {
  const path = 'app_src/lib/persistence/commerceExternalEffects.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Array,
    Boolean,
    Buffer,
    Date,
    Error,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === '@/lib/persistence/postgres') {
        return {
          acquireTransactionAdvisoryLock: async () => {},
          query: async () => {
            throw new Error('database must not be reached by pure tests')
          },
          withTransaction: async () => {
            throw new Error('database must not be reached by pure tests')
          },
        }
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

const migration = read(
  'db/migrations/0148_operations_commerce_external_effects.sql',
)
const persistence = read(
  'app_src/lib/persistence/commerceExternalEffects.ts',
)

includes(migration, [
  "('gcef'",
  "'operations.commerce_external_effect_intent'",
  'operations_commerce_external_effect_json_is_redacted',
  'operations_commerce_external_effect_aggregate_fences',
  'operations_commerce_external_effect_intents',
  'credential_generation integer NOT NULL',
  'activation_revision integer NOT NULL',
  'aggregate_revision bigint NOT NULL',
  'aggregate_hash text NOT NULL',
  'idempotency_key text NOT NULL',
  'request_hash text NOT NULL',
  'redacted_request jsonb NOT NULL',
  "desired_mode text NOT NULL CHECK (desired_mode IN ('shadow', 'active'))",
  "'pending', 'claimed', 'simulated', 'succeeded', 'failed', 'unknown'",
  'provider_attempt_id uuid',
  'provider_write_count integer NOT NULL DEFAULT 0',
  'operations_commerce_external_effect_intents_idempotency_unique',
  'BEFORE INSERT OR UPDATE OR DELETE',
], 'External-effect schema')

const fenceProtection = section(
  migration,
  'protect_operations_commerce_external_effect_aggregate_fence()',
  'CREATE TABLE IF NOT EXISTS operations_commerce_external_effect_intents',
  'Aggregate fence protection',
)
includes(fenceProtection, [
  'aggregate fences cannot be deleted',
  'aggregate fence identity is immutable',
  'NEW.aggregate_revision <= OLD.aggregate_revision',
  'aggregate revision must increase',
], 'Aggregate fence protection')

const stateConstraint = section(
  migration,
  'CONSTRAINT operations_commerce_external_effect_intents_state_valid',
  'CREATE INDEX IF NOT EXISTS',
  'External-effect state constraint',
)
includes(stateConstraint, [
  "desired_mode = 'active'",
  "state = 'pending'",
  "desired_mode = 'shadow'",
  "state = 'simulated'",
  'provider_attempt_id IS NULL',
  "redacted_result->>'providerWrites' = '0'",
  'provider_write_count = 0',
  "redacted_result->>'providerWrites'",
  '= provider_write_count::text',
  "state IN ('succeeded', 'failed', 'unknown')",
], 'External-effect state constraint')

const intentProtection = section(
  migration,
  'protect_operations_commerce_external_effect_intent()',
  'COMMENT ON TABLE',
  'External-effect protection trigger',
)
includes(intentProtection, [
  'external-effect intents are immutable and cannot be deleted',
  'intent identity and request are immutable',
  'account.commerce_credential_generation',
  'credential.credential_version',
  "credential.verification_status",
  'activation.state',
  'activation.revision',
  'fence.aggregate_revision',
  'fence.aggregate_hash',
  'credential fence is stale',
  'activation fence is stale',
  'aggregate fence is stale',
  "NEW.desired_mode = 'active'",
  "account_status IS DISTINCT FROM 'active'",
  "NEW.desired_mode = 'shadow'",
  "account_status NOT IN ('active', 'disabled')",
  "NEW.desired_mode = 'shadow'",
  "NEW.state <> 'simulated'",
  'Terminal commerce external-effect evidence is immutable',
  'provider write count changes only at terminal finalization',
  "OLD.state = 'pending'",
  "NEW.state <> 'claimed'",
  "OLD.desired_mode <> 'active'",
  "'external_effect:' || NEW.action",
  "attempt_state IS DISTINCT FROM 'prepared'",
  "NEW.state NOT IN ('succeeded', 'failed', 'unknown')",
  'terminal evidence must match its provider attempt',
], 'External-effect protection trigger')

assert.doesNotMatch(
  persistence,
  /\bfetch\s*\(/,
  'The persistence control plane must not make provider network calls',
)
assert.doesNotMatch(
  persistence,
  /DELETE\s+FROM\s+operations_commerce_external_effect/i,
  'External-effect evidence must never be deleted by persistence',
)
includes(persistence, [
  'prepareCommerceExternalEffectInPostgres',
  'claimCommerceExternalEffectsInPostgres',
  'finalizeCommerceExternalEffectInPostgres',
  'readCommerceExternalEffectsStateFromPostgres',
  'assertRedactedCommerceExternalEffectEvidence',
  'commerceExternalEffectHash',
  'acquireTransactionAdvisoryLock',
  'operations_commerce_external_effect_aggregate_fences',
  'operations_commerce_external_effect_intents',
  'operations_commerce_provider_attempts',
  'FOR UPDATE OF intent SKIP LOCKED',
  'globalId?: string | null',
  "AND ($2::text IS NULL OR intent.global_id = $2)",
  "intent.desired_mode = 'active'",
  'account.commerce_credential_generation =',
  'intent.credential_generation',
  'credential.credential_version = ${alias}.credential_generation',
  "credential.verification_status = 'verified'",
  "activation.state = 'active'",
  'activation.revision = ${alias}.activation_revision',
  'fence.aggregate_revision = ${alias}.aggregate_revision',
  'fence.aggregate_hash = ${alias}.aggregate_hash',
  "'external_effect:' || $3",
  "AND state = 'prepared'",
  'AND lease_token = $8::uuid',
  'Terminal external-effect evidence cannot be changed',
  'providerWriteCount: number',
  'input.redactedResult.providerWrites !== input.providerWriteCount',
  'const providerWriteCount = input.providerWriteCount',
  'claim_lease_expired_reconciliation_required',
], 'External-effect persistence')

const rowMapper = section(
  persistence,
  'function externalEffect(row: ExternalEffectRow)',
  'const EXTERNAL_EFFECT_SELECT',
  'External-effect row mapper',
)
assert.equal(
  [...rowMapper.matchAll(/providerWriteCount:/g)].length,
  1,
  'Provider write count must be mapped exactly once',
)
includes(
  section(
    persistence,
    'function assertCurrentAccountFence',
    'async function readExistingEffect',
    'External-effect account fence',
  ),
  [
    "input.desiredMode === 'active'",
    "account.status !== 'active'",
    "input.desiredMode === 'shadow'",
    "account.status === 'error'",
  ],
  'Shadow versus Active account fence',
)

const prepare = section(
  persistence,
  'export async function prepareCommerceExternalEffectInPostgres',
  'function claimabilitySql',
  'External-effect preparation',
)
assert.ok(
  prepare.indexOf('const existing = await readExistingEffect')
    < prepare.indexOf('await advanceAggregateFence'),
  'An idempotent replay must be returned before advancing an aggregate fence',
)
includes(prepare, [
  'assertCurrentAccountFence(account, input)',
  "CASE WHEN $5 = 'shadow' THEN 'simulated' ELSE 'pending' END",
  "CASE WHEN $5 = 'shadow' THEN now() ELSE NULL END",
  'simulationHash',
], 'External-effect preparation')

const claim = section(
  persistence,
  'export async function claimCommerceExternalEffectsInPostgres',
  'function validateTerminalInput',
  'External-effect claim',
)
assert.ok(
  claim.indexOf('operations_commerce_provider_attempts')
    < claim.indexOf("SET state = 'claimed'"),
  'A durable provider attempt must exist before an intent becomes claimable work',
)
includes(claim, [
  'const leaseToken = randomUUID()',
  "'prepared', 1, $8::uuid",
  'attempt_number',
  'lease_expires_at',
  "intent.state = 'pending'",
  "intent.desired_mode = 'active'",
], 'External-effect claim')

const finalize = section(
  persistence,
  'export async function finalizeCommerceExternalEffectInPostgres',
  'export async function readCommerceExternalEffectsStateFromPostgres',
  'External-effect finalization',
)
assert.ok(
  finalize.indexOf('UPDATE operations_commerce_provider_attempts')
    < finalize.indexOf('UPDATE operations_commerce_external_effect_intents'),
  'Provider-attempt evidence must finalize before the linked intent',
)
includes(finalize, [
  'TERMINAL_STATES.has(current.state)',
  'current.terminal_evidence_hash === terminalEvidenceHash',
  "current.state !== 'claimed'",
  'current.lease_token !== input.leaseToken',
  "AND state = 'prepared'",
  'AND lease_token = $8::uuid',
  "intent.state = 'claimed'",
  'intent.lease_token = $10::uuid',
], 'External-effect finalization')

const {
  assertRedactedCommerceExternalEffectEvidence,
  commerceExternalEffectHash,
  prepareCommerceExternalEffectInPostgres,
} = loadPersistence()

assert.equal(
  commerceExternalEffectHash({
    z: [3, { b: true, a: 'value' }],
    a: 1,
  }),
  commerceExternalEffectHash({
    a: 1,
    z: [3, { a: 'value', b: true }],
  }),
  'External-effect hashes must be independent of object insertion order',
)
assert.equal(
  commerceExternalEffectHash({ value: -0 }),
  commerceExternalEffectHash({ value: 0 }),
  'External-effect hashes must normalize negative zero',
)
assert.throws(
  () => commerceExternalEffectHash({ value: Number.POSITIVE_INFINITY }),
  (error) => (
    error.code === 'COMMERCE_EXTERNAL_EFFECT_JSON_INVALID'
  ),
  'Non-finite evidence values must fail closed',
)
assert.doesNotThrow(
  () => assertRedactedCommerceExternalEffectEvidence({
    credentialGeneration: 3,
    tokenLastFour: 'abcd',
    headers: { accept: 'application/json' },
  }),
  'Non-secret credential metadata is valid redacted evidence',
)
for (const unsafe of [
  { accessToken: 'plaintext' },
  { nested: { client_secret: 'plaintext' } },
  { headers: { 'X-Shopify-Access-Token': 'plaintext' } },
]) {
  assert.throws(
    () => assertRedactedCommerceExternalEffectEvidence(unsafe),
    (error) => (
      error.code === 'COMMERCE_EXTERNAL_EFFECT_EVIDENCE_NOT_REDACTED'
    ),
    'Secret-shaped evidence keys must fail closed',
  )
}

await assert.rejects(
  prepareCommerceExternalEffectInPostgres({
    organizationId: '11111111-1111-4111-8111-111111111111',
    accountGlobalId: 'gia1234567',
    provider: 'shopify',
    action: 'inventory.update',
    desiredMode: 'shadow',
    credentialGeneration: 2,
    activationRevision: 7,
    aggregateType: 'operations.inventory_position',
    aggregateId: 'giv1234567',
    aggregateRevision: 3,
    aggregateHash: 'a'.repeat(64),
    idempotencyKey: 'shadow-write-adversarial',
    redactedRequest: { inventoryItemId: 'gid://shopify/InventoryItem/1' },
    simulationEvidence: { providerWrites: 1 },
  }),
  (error) => (
    error.code === 'COMMERCE_EXTERNAL_EFFECT_SHADOW_WRITE_INVALID'
  ),
  'Shadow preparation must reject any claimed provider write',
)

console.log('commerce external-effect tests passed')
