#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function includes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} is missing ${fragment}`)
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(value[key])}`
  )).join(',')}}`
}

function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function loadPersistence() {
  const path =
    'app_src/lib/persistence/shopifyCarrierServiceMutationAuthorization.ts'
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
      if (specifier === '@/lib/auditWriter') {
        return { recordAuditEvent: async () => {} }
      }
      if (
        specifier ===
        '@/lib/persistence/commerceExternalEffects'
      ) {
        return {
          assertRedactedCommerceExternalEffectEvidence: () => {},
          commerceExternalEffectHash: hash,
        }
      }
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
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const migration = read(
  'db/migrations/0150_operations_shopify_carrier_service_mutation_authorization.sql',
)
const persistenceSource = read(
  'app_src/lib/persistence/shopifyCarrierServiceMutationAuthorization.ts',
)
const setupPersistenceSource = read(
  'app_src/lib/persistence/shopifyCheckoutRating.ts',
)
const setupRouteSource = read(
  'app_src/app/api/integrations/commerce/shopify/carrier-service/route.ts',
)

includes(migration, [
  'operations_shopify_carrier_service_mutation_authorizations',
  'operations_shopify_carrier_service_mutation_attempts',
  'operations_shopify_carrier_service_mutation_outcomes',
  'operations_shopify_carrier_service_mutation_resolutions',
  'redacted_evidence jsonb NOT NULL',
  'ops_shopify_cs_mut_resolution_redacted',
  'operations_shopify_carrier_service_config_mutation_links',
  "operation IN ('create', 'delete')",
  "account_environment IN ('sandbox', 'production')",
  "NEW.operation = 'create'",
  "NEW.account_environment IS DISTINCT FROM 'sandbox'",
  'production is limited to exact delete reconciliation',
  "activation_state = 'shadow'",
  'credential_generation integer NOT NULL',
  'config_row_version bigint NOT NULL',
  'activation_revision integer NOT NULL',
  'aggregate_hash text NOT NULL',
  'request_hash text NOT NULL',
  'confirmation_hash text NOT NULL',
  'authorization_fence_hash text GENERATED ALWAYS AS',
  "expires_at <= authorized_at + interval '5 minutes'",
  'UNIQUE (authorization_id)',
  'mutation attempts are append-only',
  'mutation outcomes are append-only',
  'mutation resolutions are append-only',
  'configuration mutation links are append-only',
  'operations_shopify_carrier_service_actor_can_authorize',
  "membership.role = 'owner'",
  "membership.role = 'admin'",
  "membership.permissions->>'manageOperations'",
  "effect.desired_mode",
  "effect_state IS DISTINCT FROM 'simulated'",
  "effect_provider_write_count IS DISTINCT FROM 0",
  'mutation authorization expired or became stale before claim',
  'mutation_authorizations prior',
  'prior.idempotency_key IS DISTINCT FROM NEW.idempotency_key',
  "resolution.disposition = 'confirmed_not_applied'",
  'mutation evidence',
  'to_row_version = from_row_version + 1',
  'cannot be reconciled while its provider-call lease is active',
  'cannot later receive an outcome',
  'requires an unknown outcome or an expired incomplete attempt',
  'registered Shopify CarrierService identity is immutable',
  'provider state transition requires exact one-time mutation evidence',
], 'One-time CarrierService authorization schema')

const resolutionTrigger = migration.slice(
  migration.indexOf(
    'CREATE OR REPLACE FUNCTION\n  protect_ops_shopify_cs_mut_resolution()',
  ),
  migration.indexOf(
    'DROP TRIGGER IF EXISTS\n  protect_ops_shopify_cs_mut_resolution_write',
  ),
)
includes(resolutionTrigger, [
  'IF attempt_lease_expires_at > now() THEN',
  'including an unknown outcome',
], 'Unknown-outcome provider-call lease fence')
assert.doesNotMatch(
  resolutionTrigger,
  /terminal_outcome IS NULL\s+AND attempt_lease_expires_at > now\(\)/,
  'Unknown outcomes must remain fenced until their provider-call lease expires',
)

for (const pattern of [
  /CONSTRAINT\s+([a-z0-9_]+)/gi,
  /CREATE(?: UNIQUE)? INDEX IF NOT EXISTS\s+([a-z0-9_]+)/gi,
  /CREATE OR REPLACE FUNCTION\s+([a-z0-9_]+)/gi,
  /CREATE TRIGGER\s+([a-z0-9_]+)/gi,
]) {
  for (const match of migration.matchAll(pattern)) {
    assert.ok(
      Buffer.byteLength(match[1], 'utf8') <= 63,
      `PostgreSQL identifier exceeds 63 bytes: ${match[1]}`,
    )
  }
}

assert.doesNotMatch(
  migration,
  /(?:catalog|inventory|order|printing)\.(?:create|update|delete)/,
  'Authorization migration must not grant unrelated provider writes',
)
assert.doesNotMatch(
  persistenceSource,
  /\bfetch\s*\(/,
  'Authorization persistence must not call Shopify',
)
assert.doesNotMatch(
  persistenceSource,
  /(?:merchandise|subtotal|unitPrice|productPrice|cartTotal)/,
  'CarrierService registration must not depend on merchandise price',
)

includes(persistenceSource, [
  'authorizeShopifyCarrierServiceMutationInPostgres',
  'claimShopifyCarrierServiceMutationInPostgres',
  'finalizeShopifyCarrierServiceMutationInPostgres',
  'resolveShopifyCarrierServiceMutationInPostgres',
  'finalizeShopifyCarrierServiceConfigMutationInPostgres',
  'readShopifyCarrierServiceMutationAuthorizationFromPostgres',
  'readShopifyCarrierServiceMutationAuthorizationsFromPostgres',
  'shopifyCarrierServiceMutationConfirmationHash',
  'shopifyCarrierServiceMutationResolutionConfirmationHash',
  'SHOPIFY_CARRIER_SERVICE_MUTATION_RECONCILIATION_REQUIRED',
  'expectedAuthorizationFenceHash',
  'providerWriteCount !== 1',
  'providerWriteCount !== 0',
  'confirmed_applied',
  'confirmed_not_applied',
  'SHOPIFY_CARRIER_SERVICE_MUTATION_STILL_IN_FLIGHT',
  'SHOPIFY_CARRIER_SERVICE_MUTATION_ALREADY_RECONCILED',
  'link_global_id',
  'redacted_evidence, resolution_hash',
  'JSON.stringify(input.resolutionEvidence)',
  "(!outcome || outcome.state === 'unknown')",
], 'Authorization persistence')

includes(setupPersistenceSource, [
  'SHOPIFY_CHECKOUT_SCOPED_MUTATION_FINALIZER_REQUIRED',
  'Registered or disabled Shopify provider state requires the exact one-time mutation finalizer',
  "current.registrationState === 'registered'",
  'current.serviceGid !== null',
  'SHOPIFY_CHECKOUT_EXACT_DELETE_REQUIRED',
], 'Generic setup finalizer')

includes(setupRouteSource, [
  'function publicMutationAuthorization(',
  'function publicCarrierServiceConfig(',
  'leaseExpiresAt: authorization.attempt.leaseExpiresAt',
  "action === 'recover-mutation'",
  'verifyShopifyCarrierServiceMutationForReconciliation',
], 'Sanitized setup and recovery route')
assert.doesNotMatch(
  setupRouteSource,
  /providerServiceGid/,
  'CarrierService create recovery must not require an operator-supplied provider GID',
)

const publicMapper = setupRouteSource.slice(
  setupRouteSource.indexOf('function publicMutationAuthorization('),
  setupRouteSource.indexOf('function confirmationRequestId('),
)
assert.doesNotMatch(
  publicMapper,
  /\b(?:leaseToken|organizationId|integrationAccountId|configId|attempt\.id|outcome\.id|resolution\.id|redactedEvidence|resolutionEvidence)\b/,
  'Setup-state mutation DTO must not expose lease tokens or internal UUIDs',
)
const publicConfigMapper = setupRouteSource.slice(
  setupRouteSource.indexOf('function publicCarrierServiceConfig('),
  setupRouteSource.indexOf('type PublicShopifyCarrierServiceConfig'),
)
assert.doesNotMatch(
  publicConfigMapper,
  /\b(?:organizationId|integrationAccountId|warehouseId|materialId|carrierAccountId)\s*:/,
  'Setup-state configuration DTO must not expose internal UUIDs',
)

const replacementGuard = migration.slice(
  migration.lastIndexOf(
    'CREATE OR REPLACE FUNCTION\n  validate_operations_shopify_carrier_service_config()',
  ),
)
includes(replacementGuard, [
  'operations_shopify_carrier_service_config_mutation_links',
  "NEW.registration_state IN ('registered', 'disabled')",
  'requires exact one-time mutation evidence',
  "OLD.registration_state = 'registered'",
  "NEW.registration_state NOT IN ('registered', 'disabled')",
  'NEW.service_gid IS DISTINCT FROM OLD.service_gid',
], '0150 Shadow registration guard replacement')
assert.doesNotMatch(
  replacementGuard,
  /Registering a Shopify CarrierService requires Active Operations/,
  '0150 must supersede the broad 0149 Active-only registration guard',
)

const persistence = loadPersistence()
const accountGlobalId = 'gia0000001'
const configGlobalId = 'gscf0000001'
const requestHash = 'a'.repeat(64)
const actorEmail = 'Jarrett+warehouse@episcs.com'

assert.equal(
  persistence.shopifyCarrierServiceMutationConfirmationVersion(
    'sandbox',
  ),
  'shopify-carrier-service-sandbox-provider-write-v1',
)
assert.equal(
  persistence.shopifyCarrierServiceMutationConfirmationVersion(
    'production',
  ),
  'shopify-carrier-service-production-provider-write-v1',
)

const sandboxHash =
  persistence.shopifyCarrierServiceMutationConfirmationHash({
    accountGlobalId,
    configGlobalId,
    configRowVersion: 7,
    operation: 'create',
    environment: 'sandbox',
    requestHash,
    actorEmail,
    statementVersion:
      'shopify-carrier-service-sandbox-provider-write-v1',
  })
const productionHash =
  persistence.shopifyCarrierServiceMutationConfirmationHash({
    accountGlobalId,
    configGlobalId,
    configRowVersion: 7,
    operation: 'create',
    environment: 'production',
    requestHash,
    actorEmail,
    statementVersion:
      'shopify-carrier-service-production-provider-write-v1',
  })
assert.match(sandboxHash, /^[a-f0-9]{64}$/)
assert.match(productionHash, /^[a-f0-9]{64}$/)
assert.notEqual(
  sandboxHash,
  productionHash,
  'Production confirmation must be environment-distinct',
)
assert.notEqual(
  sandboxHash,
  persistence.shopifyCarrierServiceMutationConfirmationHash({
    accountGlobalId,
    configGlobalId,
    configRowVersion: 7,
    operation: 'delete',
    environment: 'sandbox',
    requestHash,
    actorEmail,
    statementVersion:
      'shopify-carrier-service-sandbox-provider-write-v1',
  }),
  'Create confirmation must not authorize delete',
)

const resolutionEvidenceHash = hash({
  source: 'shopify_admin_review',
  outcome: 'service_present',
})
const resolutionHash =
  persistence.shopifyCarrierServiceMutationResolutionConfirmationHash({
    attemptGlobalId: 'gscm0000001',
    disposition: 'confirmed_applied',
    providerReference:
      'gid://shopify/DeliveryCarrierService/123456',
    resolutionHash: resolutionEvidenceHash,
    actorEmail,
    statementVersion:
      'shopify-carrier-service-mutation-reconciliation-v1',
  })
assert.match(resolutionHash, /^[a-f0-9]{64}$/)

console.log(
  'Shopify CarrierService one-time mutation authorization contract passed.',
)
