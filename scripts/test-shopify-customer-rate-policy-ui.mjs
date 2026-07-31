#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const panel = read(
  'app_src/components/settings/ShopifyCustomerRatePolicyPanel.tsx',
)
const setupPanel = read(
  'app_src/components/settings/ShopifyCarrierServiceSetupPanel.tsx',
)

function requireAll(source, contracts, surface) {
  for (const contract of contracts) {
    assert.ok(
      source.includes(contract),
      `${surface} is missing required contract: ${contract}`,
    )
  }
}

requireAll(panel, [
  '/api/integrations/commerce/shopify/customer-rate-policies',
  "action: 'upsert'",
  "action: 'remove'",
  'expectedRowVersion: editingPolicy.rowVersion',
  'expectedRowVersion: pendingRemoval.rowVersion',
  'policy?: CustomerRatePolicy | null',
  'customerGid: customer.customerGid',
  "Object.prototype.hasOwnProperty.call(payload, 'policy')",
  'payload.policy || null',
  'body.customerCursor = customerSearch.nextCursor',
  "action: 'search'",
  'customerPageSize: 25',
  'availableServices?: AvailableService[]',
  'availableServicesTruncated?: boolean',
  'shadowDurationMinutes',
  'shadowLifetimeMode',
  'shadowPolicyLimits',
  'expiredSimulatedCount',
  'earliestShadowExpiresAt',
  "'inactive_blocked'",
], 'customer-policy API round trip')

const customerSearchStart = panel.indexOf(
  'const runCustomerSearch = async',
)
const customerSearchEnd = panel.indexOf(
  'const populateEditor =',
  customerSearchStart,
)
assert.ok(
  customerSearchStart >= 0 && customerSearchEnd > customerSearchStart,
  'customer policy search request boundary is missing',
)
const customerSearchRequest = panel.slice(
  customerSearchStart,
  customerSearchEnd,
)
requireAll(customerSearchRequest, [
  "action: 'search'",
  'accountGlobalId,',
  'search,',
  'customerPageSize: 25',
  'method: \'POST\'',
  "headers: { 'Content-Type': 'application/json' }",
  'body: JSON.stringify(body)',
  'fetch(ENDPOINT, {',
], 'body-only customer search transport')
assert.equal(
  customerSearchRequest.includes('URLSearchParams'),
  false,
  'raw customer search must not be serialized into a URL',
)
assert.equal(
  customerSearchRequest.includes('query.toString()'),
  false,
  'raw customer search must not be serialized into a query string',
)

requireAll(panel, [
  'useRef<AbortController | null>(null)',
  'policyListRequest.current?.abort()',
  'customerSearchRequest.current?.abort()',
  'exactPolicyRequest.current?.abort()',
  'mutationRequest.current?.abort()',
  'signal: controller.signal',
  'controller.signal.aborted',
  'policyListRequest.current !== controller',
  'customerSearchRequest.current !== controller',
  'exactPolicyRequest.current !== controller',
  'mutationRequest.current !== controller',
  'requestWasAborted(caught)',
  'customerSearchRequest.current === controller',
  'exactPolicyRequest.current === controller',
], 'account-switch and stale-request fencing')

requireAll(panel, [
  'maskedEmail: string | null',
  'customer.maskedEmail',
  'customerLabels[policy.customerGid]',
  '[customer.customerGid]: customer',
  'Provider-fetched display label only; the exact GID is',
  'the policy key, and this label is not persisted.',
], 'ephemeral masked customer labels')
assert.equal(
  /customer\.email\b/u.test(panel),
  false,
  'customer policy UI must consume only server-masked customer emails',
)

const saveStart = panel.indexOf('const savePolicy = async () =>')
const removeStart = panel.indexOf('const removePolicy = async () =>')
assert.ok(
  saveStart >= 0 && removeStart > saveStart,
  'customer policy save boundary is missing',
)
const savePolicy = panel.slice(saveStart, removeStart)
for (const nonAuthoritativeLabel of ['displayName', 'maskedEmail']) {
  assert.equal(
    savePolicy.includes(nonAuthoritativeLabel),
    false,
    `customer labels must not be persisted: ${nonAuthoritativeLabel}`,
  )
}

requireAll(panel, [
  'Checkout audience',
  'Shadow default · hide ClawPilot rates.',
  'A selected, signed-in Shopify customer is',
  'Active default · show all eligible ClawPilot rates.',
  'includes guest checkouts',
  'Checkout default unavailable.',
  'Provider enforcement unavailable',
  'explicit local proof intent only',
  'Shopify does not guarantee that',
  'a CarrierService callback contains Customer GID',
  'without that identity fails closed',
  'no customer-count cap',
  "effectiveActivation === 'shadow'",
  "effectiveActivation === 'active'",
  'Add,',
  'edit, and remove actions require the exact organization to be in',
  'Shadow or Active. Existing policies remain visible for review.',
], 'checkout audience semantics')

requireAll(panel, [
  'an administrator chooses either a 15–240 minute local',
  'test window or Until turned off. Both perform zero Shopify writes.',
  'rate cache is customer-neutral.',
  'bounded, isolated allowlisted test-variant proof—not',
  'Delivery Customization is required before customer-specific',
  'Provider enforcement blocked',
  'Provider enforcement simulated only',
  'Shopify writes',
], 'truthful provider-enforcement boundary')

requireAll(panel, [
  'Shadow lifetime',
  'Timed proof window',
  'Until turned off',
  "shadowLifetimeMode === 'timed'",
  "value=\"until_turned_off\"",
  'shadowPolicyLimits.supportedLifetimeModes',
  'shadowPolicyLimits.defaultLifetimeMode',
  'Shadow proof duration (minutes)',
  'shadowPolicyLimits.minimumDurationMinutes',
  'shadowPolicyLimits.maximumDurationMinutes',
  'shadowPolicyLimits.defaultDurationMinutes',
  '? { shadowDurationMinutes }',
  'Saving or renewing starts a new bounded window; expiration fails closed.',
  'Until turned off has no automatic expiry.',
  'an administrator must edit or remove this',
  'successful rate response for up to 15 minutes after the policy',
  'disabling the policy is not an immediate cache',
  'policy.shadowExpired',
  'Shadow expired · fails closed',
  'policy.shadowExpiresAt',
  "policy.shadowLifetimeMode === 'until_turned_off'",
  'Shadow · Until turned off',
], 'explicit Shadow lifetime controls')

requireAll(panel, [
  'Search Shopify by customer name, email, or exact Customer GID.',
  'Customer name, email, or Shopify Customer GID',
  'gid://shopify/Customer/1234567890',
  'The Customer GID identifies the Shopify customer record;',
  'Load more Shopify customers',
  'Shopify customer search is unavailable',
  'You can still enter an exact Shopify Customer GID below.',
], 'Shopify customer search and identity help')

requireAll(panel, [
  "value: 'show_all'",
  "value: 'hide_all'",
  "value: 'include_only'",
  "value: 'exclude'",
  ".split(/[,\\n]+/u)",
  ".toLowerCase()",
  "`clawpilot:${part}`",
  'clawpilot:<carrier>:<service>',
  'Up to 50 services may be filtered per customer.',
  'after the first successful whole-shipment quote.',
  '<code>clawpilot:ups:ground</code>',
  '<code>clawpilot:fedex:home_delivery</code>',
  'Services from successful quotes',
  'service.shopifyServiceCode',
  'No stable service suggestions are available yet.',
  'The suggestion list is truncated to 100 retained services.',
  'Advanced ClawPilot service-code entry',
], 'per-customer service filter controls')

requireAll(setupPanel, [
  "from '@/components/settings/ShopifyCustomerRatePolicyPanel'",
  '<ShopifyCustomerRatePolicyPanel',
  'accountGlobalId={accountGlobalId}',
  'activationState={setup.reference.activation.state}',
  'canManage={setup.canManage}',
  "key: 'audience'",
  "key: 'rate-warm'",
  "key: 'evidence'",
  'Only binary allow or hide is testable in Shadow.',
  'Customer-specific and per-service Shopify enforcement requires an eligible Delivery Customization',
  'Refresh checkout-audience status',
], 'carrier-service setup integration')
const audienceStep = setupPanel.indexOf("key: 'audience'")
const rateWarmStep = setupPanel.indexOf("key: 'rate-warm'")
const evidenceStep = setupPanel.indexOf("key: 'evidence'")
assert.ok(
  audienceStep >= 0
    && rateWarmStep > audienceStep
    && evidenceStep > rateWarmStep,
  'checkout audience must precede cache preparation and live proof',
)
assert.equal(
  /[A-Z0-9._%+-]+@episcs\.com/iu.test(setupPanel),
  false,
  'generic checkout setup must not contain a tenant customer email address',
)

assert.equal(
  /MAX_(?:CUSTOMERS|CUSTOMER_POLICIES|POLICY_CUSTOMERS)/u.test(panel),
  false,
  'the UI must not impose a customer-policy count cap',
)

console.log('Shopify customer rate-policy UI contracts passed.')
