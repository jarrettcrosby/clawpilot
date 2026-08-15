#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (relativePath) => readFileSync(
  resolve(root, relativePath),
  'utf8',
)

const policy = read(
  'app_src/lib/operations/shopifyCheckoutAudiencePolicy.ts',
)
const guard = read(
  'app_src/lib/integrations/shopifyShadowCheckoutGuard.ts',
)
const callback = read(
  'app_src/lib/integrations/shopifyCarrierServiceCallback.ts',
)
const rateWarm = read(
  'app_src/lib/integrations/shopifyRateWarm.ts',
)
const rateWarmRuntime = read(
  'app_src/lib/integrations/shopifyRateWarmRuntime.ts',
)
const route = read(
  'app_src/app/api/integrations/commerce/shopify/carrier-service/route.ts',
)
const persistence = read(
  'app_src/lib/persistence/shopifyCheckoutRating.ts',
)
const panel = read(
  'app_src/components/settings/ShopifyCarrierServiceSetupPanel.tsx',
)
const migration = read(
  'db/migrations/0293_shopify_checkout_audience_policy.sql',
)
const packageJson = JSON.parse(read('package.json'))

function requireAll(source, fragments, surface) {
  for (const fragment of fragments) {
    assert.ok(
      source.includes(fragment),
      `${surface} is missing required contract: ${fragment}`,
    )
  }
}

requireAll(policy, [
  "'shopify-checkout-audience-v1'",
  "'off'",
  "'restricted_customers'",
  "'all_eligible'",
  "mode: 'restricted_customers'",
  'if (value === undefined) return defaultPolicy()',
  'keys.length !== 2',
  "!keys.includes('version')",
  "!keys.includes('mode')",
  'SHOPIFY_CHECKOUT_AUDIENCE_POLICY_INVALID',
], 'strict checkout-audience normalization')

requireAll(guard, [
  'SHOPIFY_SHADOW_GUARD_AUDIENCE_OFF',
  'SHOPIFY_SHADOW_GUARD_ALL_ELIGIBLE_SANDBOX_REQUIRED',
  'customerRequired?: boolean',
  'variantAllowlistRequired?: boolean',
  'input.customerRequired !== false',
  'input.variantAllowlistRequired !== false',
], 'Shadow audience guard')

requireAll(callback, [
  'lookupShopifyCarrierServiceCallbackPolicyByGlobalIdInPostgres({',
  "checkpoint: 'account_authenticated'",
  "audience.mode === 'off'",
  "audience.mode === 'all_eligible'",
  "account.environment !== 'sandbox'",
  "audience.mode === 'restricted_customers'",
  'variantAllowlistRequired:',
  'readActiveShopifyCustomerRatePolicyFromPostgres({',
  'readShopifyCheckoutContextFromPostgres({',
], 'callback audience boundary')

assert.ok(
  callback.indexOf(
    'lookupShopifyCarrierServiceCallbackPolicyByGlobalIdInPostgres({',
  ) < callback.indexOf(
    'lookupShopifyCheckoutRatingAccountByGlobalIdInPostgres({',
  ),
  'The authenticated Off kill switch must precede strict rating readiness',
)

requireAll(rateWarm, [
  'readAudiencePolicy:',
  "audienceMode = 'off'",
  "audienceMode === 'all_eligible'",
  "audienceMode === 'restricted_customers'",
  'isShadowCustomerAllowed(',
  'shadowAudienceAllowed',
], 'audience-aware checkout rate warming')
requireAll(rateWarmRuntime, [
  'readShopifyCheckoutAudiencePolicy',
  'readAudiencePolicy: readShopifyCheckoutAudiencePolicy',
], 'rate-warm audience runtime wiring')

const allEligibleBranch = callback.slice(
  callback.indexOf("audience.mode === 'all_eligible'"),
  callback.indexOf(
    'readActiveShopifyCustomerRatePolicyFromPostgres({',
  ),
)
assert.match(
  allEligibleBranch,
  /variantAllowlistRequired:\s*audience\.mode === 'restricted_customers'/u,
  'All eligible must bypass only the legacy Shadow variant allowlist',
)
assert.match(
  allEligibleBranch,
  /if \(audience\.mode === 'all_eligible'\) \{\s*return \{ allowed: true, customerPolicy: null \}/u,
  'All eligible guest carts must bypass customer-policy lookup',
)

requireAll(route, [
  "action === 'save-checkout-audience'",
  'requireActivator(context.capabilities.canActivate)',
  "current.reference.activation.state !== 'shadow'",
  'normalizeShopifyCheckoutAudiencePolicy(',
  'updateShopifyCarrierServiceAudiencePolicyInPostgres({',
  "shadowCheckoutAudience.mode === 'all_eligible'",
  "current.account.environment !== 'sandbox'",
  'SHOPIFY_CHECKOUT_AUDIENCE_SANDBOX_REQUIRED',
], 'authenticated audience API')

requireAll(persistence, [
  'lookupShopifyCarrierServiceCallbackPolicyByGlobalIdInPostgres(',
  "config.callback_token_hash = $2",
  "activation.state IN ('shadow', 'active')",
  'updateShopifyCarrierServiceAudiencePolicyInPostgres(',
  'expectedRowVersion:',
  "current.activation_state !== 'shadow'",
  "current.account_status !== 'active'",
  "current.verification_status !== 'verified'",
  'current.credential_version !== current.credential_generation',
  "input.shadowCheckoutAudience.mode === 'all_eligible'",
  "current.account_environment !== 'sandbox'",
  'SHOPIFY_CHECKOUT_AUDIENCE_SANDBOX_REQUIRED',
  'SET policy_revision = policy_revision + 1',
  'row_version = row_version + 1',
  'operations.shopify_carrier_service.checkout_audience_updated',
  'providerRegistrationRetained: true',
  'providerWrites: 0',
], 'optimistic zero-provider-write audience persistence')

const audiencePersistence = persistence.slice(
  persistence.indexOf(
    'export async function updateShopifyCarrierServiceAudiencePolicyInPostgres',
  ),
  persistence.indexOf(
    'export async function finalizeShopifyCarrierServiceRegistrationInPostgres',
  ),
)
assert.doesNotMatch(
  audiencePersistence,
  /shopifyCommerceRequest|fetch\s*\(|providerRequest/u,
  'Audience-only persistence must not call Shopify or another provider',
)

requireAll(panel, [
  'The Shopify callback remains registered store-wide.',
  'Off — return no ClawPilot rates',
  'Restricted customers — require an exact active policy',
  'All eligible checkouts',
  "disabled={setup.account.environment !== 'sandbox'}",
  "run('save-checkout-audience'",
  'Save checkout audience',
  'const callbackServingReady = Boolean(',
  'Not serving · CarrierService setup incomplete or stale',
  'Not serving · All eligible requires a sandbox store',
  'Verify the checkout-rate kill switch',
  'authenticated callback must return an empty 200 response',
], 'checkout-audience UI')

requireAll(migration, [
  'operations_shopify_checkout_audience_policy_is_valid(input jsonb)',
  "jsonb_typeof(input) IS DISTINCT FROM 'object'",
  '(SELECT count(*) FROM jsonb_object_keys(input)) <> 2',
  "'restricted_customers'",
  "'all_eligible'",
  'WITH normalized AS (',
  "config.policy_snapshot -> 'shadowCheckoutAudience'",
  ') IS NOT TRUE',
  'canonical_operations_shopify_checkout_policy_jsonb(',
  'policy_revision = config.policy_revision + 1',
  'row_version = config.row_version + 1',
  'operations_shopify_configs_checkout_audience_valid',
  ') IS NOT FALSE',
  'NOT VALID',
  'VALIDATE CONSTRAINT',
], '0293 backfill and malformed-policy fence')

assert.equal(
  packageJson.scripts['test:shopify-checkout-audience-policy'],
  'node --experimental-strip-types --test app_src/tests/integrations/shopify-checkout-audience-policy.test.ts app_src/tests/integrations/shopify-shadow-checkout-guard.test.ts app_src/tests/integrations/shopify-rate-warm.test.ts && node --experimental-test-module-mocks --experimental-strip-types --test app_src/tests/integrations/shopify-shadow-checkout-callback-boundary.test.ts && node scripts/test-shopify-checkout-audience-policy.mjs && node scripts/test-shopify-checkout-audience-persistence-postgres.mjs && node scripts/test-shopify-checkout-audience-health.mjs',
  'Focused audience test command must cover policy, callback, persistence, migration, and health',
)

console.log('Shopify checkout-audience policy contracts passed')
