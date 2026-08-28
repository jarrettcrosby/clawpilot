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
const rateControl = read(
  'app_src/lib/operations/shopifyCheckoutRateControl.ts',
)
const pendingCommand = read(
  'app_src/lib/operations/shopifyCheckoutRateControlCommand.ts',
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
const customerPolicies = read(
  'app_src/lib/persistence/shopifyCustomerRatePolicies.ts',
)
const panel = read(
  'app_src/components/settings/ShopifyCarrierServiceSetupPanel.tsx',
)
const migration = read(
  'db/migrations/0299_operations_shopify_checkout_rate_control.sql',
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
  'customerRequired?: boolean',
  'variantAllowlistRequired?: boolean',
  'input.customerRequired !== false',
  'input.variantAllowlistRequired !== false',
], 'Shadow audience guard')

requireAll(rateControl, [
  "'shopify-checkout-rate-control-v1'",
  "'off'",
  "'restricted_customers'",
  "'all_eligible'",
  "'sandbox'",
  "'production'",
  'shopifyCheckoutRateControlCanServe',
  'SHOPIFY_CHECKOUT_RATES_EMERGENCY_DISABLED',
  'SHOPIFY_CHECKOUT_RATES_EMERGENCY_FROZEN',
  "typeof candidate.audience !== 'string'",
], 'explicit checkout-rate control')

requireAll(pendingCommand, [
  'accountGlobalId: string',
  'actorEmail: string',
  'configGlobalId: string',
  'expectedConfigGlobalId: string',
  'expectedPolicyRevision: number',
  'persistShopifyCheckoutRateControlPendingCommand',
  'storage.setItem(key, encoded)',
  'const retained = storage.getItem(key)',
  'assertShopifyCheckoutRateControlCommandResult',
  'result.accountGlobalId !== input.accountGlobalId',
  'input.command.accountGlobalId !== input.accountGlobalId',
  'input.command.configGlobalId !== input.configGlobalId',
  'result.idempotencyKey !== input.command.idempotencyKey',
  'result.providerWrites !== 0',
  'lastChange.idempotencyKey === command.idempotencyKey',
  "return 'superseded'",
], 'durable browser-session command replay')

requireAll(callback, [
  'lookupShopifyCarrierServiceCallbackPolicyByGlobalIdInPostgres({',
  "checkpoint: 'account_authenticated'",
  "audience === 'off'",
  "audience === 'all_eligible'",
  "audience === 'restricted_customers'",
  'variantAllowlistRequired: false',
  'readShopifyCheckoutCustomerRatePolicyFromPostgres({',
  'filterCheckoutProviderResultForCustomerPolicy(',
  'shopifyCustomerRatePolicyAllowsService(',
  'readShopifyCheckoutContextFromPostgres({',
], 'callback audience boundary')
assert.doesNotMatch(
  callback,
  /SHOPIFY_CHECKOUT_SHADOW_ALLOWED_VARIANT_IDS|configuredShopifyNumericIdentifierSet/u,
  'Restricted checkout must not retain a hidden environment variant gate',
)

assert.ok(
  callback.indexOf(
    'lookupShopifyCarrierServiceCallbackPolicyByGlobalIdInPostgres({',
  ) < callback.indexOf(
    'lookupShopifyCheckoutRatingAccountByGlobalIdInPostgres({',
  ),
  'The authenticated Off boundary must precede strict rating readiness',
)

requireAll(rateWarm, [
  'readRateControl:',
  'shopifyCheckoutRateControlCanServe({',
  'rateControlCanServe',
  'activationState: tenant.activationState',
  'accountEnvironment: tenant.environment',
  "rateControl?.audience === 'all_eligible'",
  "rateControl?.audience === 'restricted_customers'",
  'isShadowCustomerAllowed(',
  'customerAllowed',
], 'audience-aware checkout rate warming')
assert.ok(
  rateWarm.indexOf('shopifyCheckoutRateControlCanServe({')
    < rateWarm.indexOf('isShadowCustomerAllowed('),
  'Effective checkout controls must stop warming before customer-policy reads',
)
requireAll(rateWarmRuntime, [
  'readShopifyCheckoutRateControl',
  'readRateControl: readShopifyCheckoutRateControl',
], 'rate-warm audience runtime wiring')

const allEligibleBranch = callback.slice(
  callback.indexOf("audience === 'all_eligible'"),
  callback.indexOf(
    'readShopifyCheckoutCustomerRatePolicyFromPostgres({',
  ),
)
assert.match(
  allEligibleBranch,
  /audience === 'all_eligible'\) \{\s*return \{ allowed: true, customerPolicy: null \}/u,
  'All eligible guest carts must bypass customer-policy lookup',
)

requireAll(route, [
  "action === 'save-checkout-rate-control'",
  'requireActivator(context.capabilities.canActivate)',
  'normalizeShopifyCheckoutRateControl(',
  "strictString(body.reason, 'Change reason')",
  'expectedConfigGlobalId: configGlobalId(',
  'expectedPolicyRevision: integer(',
  'updateShopifyCarrierServiceRateControlInPostgres({',
  'SHOPIFY_CHECKOUT_RATE_CONTROL_MIGRATION_REQUIRED',
  'customerPolicySummary.checkoutEligibleCount',
], 'authenticated audience API')
const broadRouteSave = route.slice(
  route.indexOf("if (action === 'save-config')"),
  route.indexOf("} else if (action === 'save-checkout-rate-control')"),
)
assert.doesNotMatch(
  broadRouteSave,
  /body\.checkoutRateControl/u,
  'Broad setup route must preserve rather than rewrite checkout-rate control',
)

requireAll(persistence, [
  'lookupShopifyCarrierServiceCallbackPolicyByGlobalIdInPostgres(',
  "config.callback_token_hash = $2",
  'updateShopifyCarrierServiceRateControlInPostgres(',
  'expectedRowVersion:',
  'expectedConfigGlobalId:',
  'expectedPolicyRevision:',
  'input.checkoutRateControl',
  'SHOPIFY_CHECKOUT_RATE_CONTROL_IDEMPOTENCY_CONFLICT',
  'response_json',
  'SET policy_revision = policy_revision + 1',
  'row_version = row_version + 1',
  'operations.shopify_carrier_service.checkout_rate_control_updated',
  "version: 'shopify-checkout-rate-control-command-v2'",
  'providerRegistrationRetained: true',
  'providerWrites: 0',
], 'optimistic zero-provider-write audience persistence')

const audiencePersistence = persistence.slice(
  persistence.indexOf(
    'export async function updateShopifyCarrierServiceRateControlInPostgres',
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
  'Off — return no ClawPilot rates',
  'Restricted customers — require an exact local policy',
  'All eligible checkouts',
  'persistShopifyCheckoutRateControlPendingCommand(',
  'selectShopifyCheckoutRateControlFormState({',
  'assertShopifyCheckoutRateControlCommandResult({',
  'setPendingRateControlCommand(retainedPending)',
  "setCheckoutRateControlReason(rateControlForm.reason ?? '')",
  'pendingRateControlCommand.accountGlobalId === accountGlobalId',
  'setup.config.globalId',
  'setup.actorEmail.trim().toLowerCase()',
  'setSetup(null)',
  'Retry exact pending save',
  'Eligible restricted customers',
  'const callbackServingReady = Boolean(',
  'Confirm checkout rates are off',
  'Shopify may reuse a cached rate for up to 15 minutes.',
  'Only mapped, in-stock items with usable packaging',
], 'checkout-audience UI')
assert.doesNotMatch(
  panel,
  /account\.configGlobalId/u,
  'Checkout-rate commands must use the authoritative config object identity',
)
const broadSave = panel.slice(
  panel.indexOf("const saveConfig = () => run('save-config'"),
  panel.indexOf('const savePlanRatePolicy'),
)
assert.doesNotMatch(
  broadSave,
  /checkoutRateControl/u,
  'Broad setup save must not bypass the dedicated receipt-backed command',
)
assert.doesNotMatch(
  panel,
  /checkout-rate kill switch|isolated allowlisted item/u,
  'Checkout setup must not claim an immediate kill switch or hidden variant allowlist',
)

requireAll(migration, [
  'operations_shopify_checkout_rate_control_is_valid(input jsonb)',
  "jsonb_typeof(input) IS DISTINCT FROM 'object'",
  '(SELECT count(*) FROM jsonb_object_keys(input)) <> 3',
  "'restricted_customers'",
  "'all_eligible'",
  'WITH normalized AS (',
  "config.policy_snapshot -> 'checkoutRateControl'",
  ') IS NOT TRUE',
  'canonical_operations_shopify_checkout_policy_jsonb(',
  'policy_revision = config.policy_revision + 1',
  'row_version = config.row_version + 1',
  'operations_shopify_configs_rate_control_valid',
  'validate_operations_shopify_checkout_rate_control_config()',
  'protect_ops_shopify_cs_mut_authorization()',
  "= 'restricted_customers'",
  "= 'production'",
  'NOT VALID',
  'VALIDATE CONSTRAINT',
], '0293 backfill and malformed-policy fence')

assert.equal(
  packageJson.scripts['test:shopify-checkout-audience-policy'],
  'node --experimental-strip-types --test app_src/tests/integrations/shopify-checkout-audience-policy.test.ts app_src/tests/integrations/shopify-checkout-rate-control.test.ts app_src/tests/integrations/shopify-shadow-checkout-guard.test.ts app_src/tests/integrations/shopify-rate-warm.test.ts && node --experimental-test-module-mocks --experimental-strip-types --test app_src/tests/integrations/shopify-shadow-checkout-callback-boundary.test.ts app_src/tests/integrations/shopify-single-carrier-callback.test.ts && node scripts/test-shopify-checkout-audience-policy.mjs && node scripts/test-shopify-checkout-audience-persistence-postgres.mjs && node scripts/test-shopify-checkout-audience-health.mjs',
  'Focused audience test command must cover policy, callback, persistence, migration, and health',
)

console.log('Shopify checkout-audience policy contracts passed')
