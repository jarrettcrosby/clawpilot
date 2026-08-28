#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const path = 'app_src/lib/persistence/shopifyReversalFixture.ts'
const source = readFileSync(resolve(path), 'utf8')
const organizationId = 'c6c8e6e7-fffa-4969-9526-e99da0ab2754'
const actorEmail = 'owner@example.test'
const commandId = '11111111-1111-4111-8111-111111111111'
const attemptId = '22222222-2222-4222-8222-222222222222'
const authority = Object.freeze({
  organizationId,
  actorEmail,
  actorRole: 'owner',
  integrationAccountId: '33333333-3333-4333-8333-333333333333',
  accountGlobalId: 'giah34fedoa5b1o',
  externalAccountId: 'gid://shopify/Shop/95083757815',
  shopDomain: 'test-pro-bakery-bites.myshopify.com',
  controlRowVersion: 7,
  credentialGeneration: 3,
  grantedScopeDigest: 'a'.repeat(64),
  grantedScopes: [
    'read_orders',
    'write_orders',
    'write_merchant_managed_fulfillment_orders',
  ],
  databaseIdentity: '750aa268-0e31-4065-a99c-4016e4d4fab1',
})

const rows = { commands: [], outcomes: [] }
const audits = []
let failingAuditEvent = null
let activeClient = null

const commandRow = {
  id: commandId,
  global_id: 'gsfc1234567',
  organization_id: organizationId,
  phase: 'create_order',
  prepared_by: actorEmail,
  prepared_role: 'owner',
  idempotency_key: 'fixture-atomic-12345678',
  intent_hash: 'b'.repeat(64),
  confirmation_hash: 'c'.repeat(64),
  provider_payload_hash: 'd'.repeat(64),
  source_identifier: 'clawpilot-reversal-fixture:gsfc1234567',
  unique_tag: 'clawpilot-reversal-0123456789abcdef01234567',
  tag_fingerprint: 'e'.repeat(64),
  predecessor_command_id: null,
  order_id: null,
  order_global_id: null,
  external_order_id: null,
  expected_order_row_version: null,
  released_at: null,
  provider_location_id: null,
  expected_lines: null,
  fulfillment_attempt_signature: null,
  fulfillment_attempt_signature_hash: null,
  prepared_at: '2026-08-25T12:00:00.000Z',
  expires_at: '2099-08-25T12:05:00.000Z',
  integration_account_id: authority.integrationAccountId,
  external_account_id: authority.externalAccountId,
  shop_domain: authority.shopDomain,
  provider_write_control_row_version: String(authority.controlRowVersion),
  credential_generation: authority.credentialGeneration,
  granted_scope_digest: authority.grantedScopeDigest,
  granted_scopes: [...authority.grantedScopes],
  database_identity: authority.databaseIdentity,
}

const client = {
  async query(sql) {
    assert.equal(activeClient, client, 'writes must use the transaction client')
    if (sql.includes('operations_shopify_reversal_fixture_commands')) {
      rows.commands.push({ ...commandRow })
      return { rows: [{ ...commandRow }] }
    }
    if (sql.includes('operations_shopify_reversal_fixture_outcomes')) {
      const outcome = {
        global_id: 'gsfo1234567',
        outcome_state: 'succeeded',
        recorded_at: '2026-08-25T12:00:02.000Z',
      }
      rows.outcomes.push(outcome)
      return { rows: [outcome] }
    }
    throw new Error(`Unexpected transaction SQL: ${sql.slice(0, 80)}`)
  },
}

const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: path,
}).outputText
const module = { exports: {} }
vm.runInNewContext(output, {
  Date,
  Error,
  JSON,
  Number,
  Object,
  RegExp,
  String,
  console,
  exports: module.exports,
  module,
  require(specifier) {
    if (specifier === 'node:crypto') return requireFromApp(specifier)
    if (specifier === '@/lib/auditWriter') {
      return {
        recordAuditEvent: async (event, suppliedClient) => {
          assert.equal(suppliedClient, client)
          audits.push(event.eventType)
          if (event.eventType === failingAuditEvent) {
            throw new Error(`injected ${event.eventType} audit failure`)
          }
        },
      }
    }
    if (specifier === '@/lib/integrations/shopifyReversalFixtureRuntime') {
      return {
        SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID: 'giah34fedoa5b1o',
        SHOPIFY_REVERSAL_FIXTURE_DATABASE_IDENTITY:
          '750aa268-0e31-4065-a99c-4016e4d4fab1',
        SHOPIFY_REVERSAL_FIXTURE_ORGANIZATION_ID: organizationId,
        SHOPIFY_REVERSAL_FIXTURE_SHOP_DOMAIN:
          'test-pro-bakery-bites.myshopify.com',
        SHOPIFY_REVERSAL_FIXTURE_SHOP_GID:
          'gid://shopify/Shop/95083757815',
      }
    }
    if (specifier === '@/lib/persistence/postgres') {
      return {
        query: async () => ({ rows: [] }),
        withTransaction: async (work) => {
          const commandCount = rows.commands.length
          const outcomeCount = rows.outcomes.length
          activeClient = client
          try {
            return await work(client)
          } catch (error) {
            rows.commands.length = commandCount
            rows.outcomes.length = outcomeCount
            throw error
          } finally {
            activeClient = null
          }
        },
      }
    }
    return requireFromApp(specifier)
  },
}, { filename: path })

const persistence = module.exports
const commandInput = {
  commandGlobalId: commandRow.global_id,
  authority,
  phase: 'create_order',
  idempotencyKey: commandRow.idempotency_key,
  intentHash: commandRow.intent_hash,
  confirmationHash: commandRow.confirmation_hash,
  providerPayloadHash: commandRow.provider_payload_hash,
  sourceIdentifier: commandRow.source_identifier,
  uniqueTag: commandRow.unique_tag,
  tagFingerprint: commandRow.tag_fingerprint,
}

failingAuditEvent = 'operations.shopify_reversal_fixture.prepared'
await assert.rejects(
  () => persistence.insertShopifyReversalFixtureCommandInPostgres(commandInput),
  /injected .*prepared audit failure/iu,
)
assert.equal(rows.commands.length, 0, 'prepared audit failure must roll back command')

failingAuditEvent = null
const command =
  await persistence.insertShopifyReversalFixtureCommandInPostgres(commandInput)
assert.equal(rows.commands.length, 1)
assert.equal(command.globalId, commandRow.global_id)

const outcomeInput = {
  command,
  attemptId,
  outcomeState: 'succeeded',
  providerMutationAttempted: true,
  providerWrites: 1,
  providerReference: 'gid://shopify/Order/123456789',
  providerOrderId: 'gid://shopify/Order/123456789',
  evidenceHash: 'f'.repeat(64),
}
failingAuditEvent = 'operations.shopify_reversal_fixture.outcome_recorded'
await assert.rejects(
  () => persistence.recordShopifyReversalFixtureOutcomeInPostgres(outcomeInput),
  /injected .*outcome_recorded audit failure/iu,
)
assert.equal(rows.outcomes.length, 0, 'outcome audit failure must roll back outcome')

failingAuditEvent = null
await persistence.recordShopifyReversalFixtureOutcomeInPostgres(outcomeInput)
assert.equal(rows.outcomes.length, 1)
assert.deepEqual(audits, [
  'operations.shopify_reversal_fixture.prepared',
  'operations.shopify_reversal_fixture.prepared',
  'operations.shopify_reversal_fixture.outcome_recorded',
  'operations.shopify_reversal_fixture.outcome_recorded',
])

console.log('Shopify reversal fixture persistence audit atomicity passed.')
