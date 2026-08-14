#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const migration = read(
  'db/migrations/0277_operations_commerce_authority_policies.sql',
)
assert.match(migration, /CREATE TABLE IF NOT EXISTS operations_commerce_authority_policies/)
assert.match(migration, /UNIQUE \(organization_id, integration_account_id, resource, revision\)/)
assert.match(migration, /resource IN \('orders', 'inventory'\)/)
assert.match(migration, /authority_mode = 'observation_only'/)
assert.match(
  migration,
  /desired_ingest_mode =\s*'windowed_history_and_core_order_signals_plus_poll'/,
)
assert.match(
  migration,
  /desired_ingest_mode =\s*'provider_available_history_and_continuous_poll'/,
)
assert.match(migration, /desired_ingest_mode = 'current_snapshot_and_realtime'/)
assert.match(migration, /desired_ingest_mode = 'observation_only'/)
assert.match(migration, /provider_write_mode = 'disabled'/)
assert.match(migration, /provider_write_count = 0/)
assert.match(migration, /revision = expected_previous_revision \+ 1/)
assert.match(migration, /actor_role IN \('owner', 'admin'\)/)
assert.match(migration, /membership\.status = 'active'/)
assert.match(migration, /membership\.permissions->>'manageOperations'/)
assert.match(migration, /account\.status = 'active'/)
assert.match(migration, /credential\.verification_status = 'verified'/)
assert.match(migration, /credential\.auth_mode = 'shopify_client_credentials'/)
assert.match(migration, /credential\.auth_mode IN \('faire_brand_token', 'faire_oauth'\)/)
assert.match(migration, /credential\.credential_version =/)
assert.match(migration, /account\.commerce_credential_generation/)
assert.match(migration, /commerce authority policy revisions are immutable/)
assert.match(migration, /account\.status AS account_status/)
assert.match(
  migration,
  /candidate\.provider = account\.provider/,
  'Current authority state must never relabel a prior provider policy',
)
assert.match(migration, /Actual account, credential, historical backfill, continuous poll/)

assert.match(migration, /CREATE TABLE IF NOT EXISTS operations_commerce_provider_write_scope_requests/)
assert.match(migration, /deployment_scope = 'development'/)
assert.match(migration, /state = 'blocked'/)
assert.match(migration, /provider_write_enabled = false/)
assert.match(migration, /supported_outbound_effect IS NULL/)
assert.match(migration, /credential_generation integer NOT NULL/)
assert.match(migration, /product_mapping_updated_at timestamptz NOT NULL/)
assert.match(migration, /channel_state_row_version bigint NOT NULL/)
assert.match(migration, /channel_state_source_hash text NOT NULL/)
assert.match(migration, /channel_state\.normalized_status IN \('active', 'unlisted'\)/)
assert.doesNotMatch(migration, /customer_name_snapshot/)
assert.doesNotMatch(migration, /product_name_snapshot/)
assert.match(migration, /commerce provider write scope requests are immutable/)
assert.doesNotMatch(
  migration,
  /INSERT INTO operations_commerce_provider_write_scope_requests/,
  'tenant-specific disabled intent must require an explicit operator command',
)
for (const forbiddenFixture of [
  'Warehouse Warehouse', 'Test Product', 'AG-Test-Test', 'gia9286799',
  'ga5649471', 'gp4513844', 'gpm1855275',
  '60832306-9876-4384-98e8-e179b427c3c1',
]) {
  assert.doesNotMatch(migration, new RegExp(forbiddenFixture))
}

const capability = read('app_src/lib/integrations/commerceAuthorityPolicy.ts')
assert.match(capability, /commerceAuthorityDefaults/)
assert.match(capability, /commerceAuthorityHistoricalCoverageReady/)
assert.match(capability, /provider_available_history_and_continuous_poll/)
assert.match(capability, /current_snapshot_and_realtime/)
assert.match(capability, /observation_only/)
assert.match(capability, /providerWriteAvailable: false/)
assert.match(capability, /clawPilotAuthorityAvailable: false/)
assert.match(capability, /provider_inventory_observation/)

const persistence = read('app_src/lib/persistence/commerceAuthorityPolicies.ts')
assert.match(persistence, /operations_commerce_authority_policy_current/)
assert.match(persistence, /actualReadiness/)
assert.match(persistence, /accountStatus/)
assert.match(persistence, /credential\.auth_mode = 'shopify_client_credentials'/)
assert.match(persistence, /credential\.auth_mode IN \('faire_brand_token', 'faire_oauth'\)/)
assert.match(persistence, /credentialCurrent/)
assert.match(persistence, /session\.session_kind = 'historical_backfill'/)
assert.doesNotMatch(persistence, /faire_fixed_window_orders_complete_unfenced/)
assert.match(persistence, /commerceAuthorityHistoricalCoverageReady/)
const historicalReadinessSelect = persistence.slice(
  persistence.indexOf('LEFT JOIN LATERAL (\n  SELECT session.status, session.completeness_state'),
  persistence.indexOf(') historical_backfill ON true'),
)
assert.match(historicalReadinessSelect, /session\.provider = current_policy\.provider/)
assert.match(
  historicalReadinessSelect,
  /session\.credential_generation =[\s\S]{0,100}account\.commerce_credential_generation/,
)
assert.match(historicalReadinessSelect, /ORDER BY session\.created_at DESC, session\.id DESC/)
assert.doesNotMatch(historicalReadinessSelect, /session\.policy_revision/)
assert.doesNotMatch(historicalReadinessSelect, /session\.status = 'succeeded'/)
assert.match(persistence, /session\.session_kind = 'continuous_poll'/)
assert.match(persistence, /COMMERCE_ORDER_CONTINUOUS_POLL_STALE/)
assert.match(persistence, /COMMERCE_ORDER_EVENT_PROCESSOR_PENDING/)
assert.match(persistence, /COMMERCE_ORDER_WEBHOOK_SUBSCRIPTIONS_UNREADY/)
assert.match(persistence, /SHOPIFY_ORDER_WEBHOOK_DISCOVERY_MAX_AGE_SECONDS/)
assert.match(persistence, /from '@\/lib\/integrations\/shopifyOrderWebhook'/)
assert.match(persistence, /orderWebhookSubscriptions,observedAt[\s\S]{0,300}make_interval/)
assert.match(persistence, /pg_input_is_valid\(/)
assert.match(persistence, /COMMERCE_SHOPIFY_INVENTORY_REFRESH_STALE/)
assert.match(persistence, /COMMERCE_SHOPIFY_INVENTORY_SUBSCRIPTION_UNREADY/)
assert.match(persistence, /webhookSubscriptions,requiredTopics/)
assert.match(persistence, /COMMERCE_AUTHORITY_ACTIVATION_INELIGIBLE/)
assert.match(persistence, /activation\.state AS activation_state/)
assert.match(persistence, /COMMERCE_FAIRE_INVENTORY_OBSERVATION_STALE/)
assert.match(persistence, /COMMERCE_FAIRE_INVENTORY_OBSERVATION_ONLY/)
assert.doesNotMatch(persistence, /operations_commerce_sync_cursors/)
assert.match(persistence, /mapPolicy\(\{ \.\.\.currentEvidence, \.\.\.replayed \}\)/)
assert.match(persistence, /value === 'clawpilot'/)
assert.match(persistence, /COMMERCE_AUTHORITY_OUTBOUND_CAPABILITY_UNAVAILABLE/)
assert.match(persistence, /acquireTransactionAdvisoryLock/)
assert.match(persistence, /COMMERCE_AUTHORITY_IDEMPOTENCY_CONFLICT/)
assert.match(persistence, /COMMERCE_AUTHORITY_REVISION_CONFLICT/)
assert.match(persistence, /recordAuditEvent/)
assert.match(
  persistence,
  /commerce-authority-policy:\$\{input\.organizationId\}:\$\{input\.accountGlobalId\}:\$\{input\.idempotencyKey\}/,
)
assert.doesNotMatch(
  persistence,
  /fetch\(|shopifyCommerceRequest|faireCommerceRequest|providerAttempt/,
)

const route = read('app_src/app/api/integrations/commerce/authority-policies/route.ts')
assert.match(route, /requireRequestUser\(req\)/)
assert.match(route, /operationsCapabilities\(actor\)\.canActivate/)
assert.match(route, /effectiveAuthorizationRole\(actor\)/)
assert.match(route, /activeOperationsOrganizationId\(actor\)/)
assert.match(route, /idempotencyKey\(req\)/)
assert.match(route, /assertExactFields\(body\)/)
assert.doesNotMatch(route, /body\.organizationId/)

const operator = read('scripts/record-commerce-provider-write-scope-request.mjs')
assert.match(operator, /RECORD_BLOCKED_SCOPE_WITH_ZERO_PROVIDER_WRITES/)
assert.match(operator, /TRUSTED_DEVELOPMENT_DATABASE_IDENTITY/)
assert.match(operator, /deployment\.database\.identity/)
assert.match(operator, /current_database\(\)/)
assert.doesNotMatch(operator, /RAILWAY_ENVIRONMENT_NAME/)
assert.doesNotMatch(operator, /COMMERCE_AUTHORITY_DEPLOYMENT_SCOPE/)
assert.match(operator, /process\.argv\.slice\(2\)\.includes\('--apply'\)/)
assert.match(operator, /account\.environment = 'sandbox'/)
assert.match(operator, /account\.status = 'active'/)
assert.match(operator, /credential\.verification_status = 'verified'/)
assert.match(operator, /credential\.auth_mode = 'shopify_client_credentials'/)
assert.match(operator, /state\.normalized_status IN \('active', 'unlisted'\)/)
assert.match(
  operator,
  /commerce-provider-write-scope:\$\{evidence\.organization_id\}:\$\{evidence\.account_global_id\}:\$\{input\.idempotencyKey\}/,
)
assert.doesNotMatch(
  operator,
  /shopifyCommerceRequest|faireCommerceRequest|fetch\(|graphql|mutation\s*\{/i,
)

console.log('commerce authority policy contract checks passed')
