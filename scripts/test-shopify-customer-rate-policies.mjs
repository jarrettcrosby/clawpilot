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

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

function requireAll(source, fragments, surface) {
  for (const fragment of fragments) {
    assert.ok(
      source.includes(fragment),
      `${surface} is missing required contract: ${fragment}`,
    )
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function loadPolicyModule() {
  const path = 'app_src/lib/integrations/shopifyCustomerRatePolicy.ts'
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
  }, { filename: path })
  return module.exports
}

const migration = read(
  'db/migrations/0178_operations_shopify_customer_rate_policies.sql',
)
const lifetimeMigration = read(
  'db/migrations/0181_operations_shopify_shadow_policy_lifetime.sql',
)
const subsidyMigration = read(
  'db/migrations/0188_operations_shopify_shadow_test_subsidy.sql',
)
const policyIntegration = read(
  'app_src/lib/integrations/shopifyCustomerRatePolicy.ts',
)
const persistence = read(
  'app_src/lib/persistence/shopifyCustomerRatePolicies.ts',
)
const route = read(
  'app_src/app/api/integrations/commerce/shopify/'
  + 'customer-rate-policies/route.ts',
)

requireAll(migration, [
  "'gscp'",
  'CREATE TABLE IF NOT EXISTS operations_shopify_customer_rate_policies',
  "'^gid://shopify/Customer/[1-9][0-9]{0,19}$'",
  "'show_all', 'hide_all', 'include_only', 'exclude'",
  'service_code_count > 50',
  'count(DISTINCT item.value)',
  "status IN ('simulated', 'blocked', 'enforced', 'error', 'removed')",
  "provider_state = 'not_written'",
  "provider_state = 'write_blocked'",
  'removed_at timestamptz',
  'shadow_duration_minutes smallint',
  'shadow_expires_at timestamptz',
  'operations_shopify_customer_rate_policy_shadow_window_valid',
  'shadow_duration_minutes BETWEEN 15 AND 240',
  'operations_shopify_customer_rate_policy_shadow_expiry_idx',
  "activation_state NOT IN ('shadow', 'active')",
  'Operations Shadow customer rate policy must remain provider-write-free',
  'is deliberately no organization- or account-level customer-count ceiling',
], 'migration 0178')
assert.equal(
  /DELETE\s+FROM\s+operations_shopify_customer_rate_policies/i.test(
    migration,
  ),
  false,
  'migration 0178 must not hard-delete customer policy evidence',
)

requireAll(lifetimeMigration, [
  'ADD COLUMN IF NOT EXISTS shadow_lifetime_mode text',
  "THEN 'timed'",
  "ELSE 'none'",
  'SET policy_hash = encode(',
  "jsonb_agg(code.value ORDER BY code.value)",
  "WHEN policy.shadow_lifetime_mode = 'none' THEN 'null'",
  "shadow_lifetime_mode = 'until_turned_off'",
  'shadow_duration_minutes IS NULL',
  'shadow_expires_at IS NULL',
  "shadow_lifetime_mode = 'timed'",
  'shadow_duration_minutes BETWEEN 15 AND 240',
  "shadow_lifetime_mode IS DISTINCT FROM 'none'",
  'must remain provider-write-free',
  'NULL duration and expiry never imply an indefinite policy',
], 'migration 0181 explicit Shadow lifetime')

assert.match(
  lifetimeMigration,
  /status = 'removed'[\s\S]*provider_state = 'not_written'[\s\S]*shadow_lifetime_mode = 'none'[\s\S]*shadow_duration_minutes IS NULL[\s\S]*shadow_expires_at IS NULL/,
  'migration 0181 must preserve valid fail-closed 0178 Shadow tombstones',
)

requireAll(subsidyMigration, [
  'ADD COLUMN IF NOT EXISTS shadow_test_charge_mode text',
  'ADD COLUMN IF NOT EXISTS shadow_test_service_code text',
  'ADD COLUMN IF NOT EXISTS shadow_test_subsidy_reason text',
  "shadow_test_charge_mode = 'carrier_rate'",
  "shadow_test_charge_mode = 'zero_single_service'",
  "status = 'simulated'",
  "provider_state = 'not_written'",
  'shadow_test_service_code ~',
  'length(shadow_test_subsidy_reason) BETWEEN 3 AND 160',
  "shadow_test_subsidy_reason !~ '[[:cntrl:]]'",
  'service_codes ? shadow_test_service_code',
  '{"version":2,"mode":',
  "NEW.shadow_test_charge_mode IS DISTINCT FROM 'carrier_rate'",
  'Only Operations Shadow may record a simulated customer rate policy',
], 'migration 0188 Shadow test subsidy')

requireAll(policyIntegration, [
  'normalizeShopifyCustomerGid',
  'normalizeShopifyCustomerRatePolicy',
  'normalizeShopifyShadowPolicyDurationMinutes',
  'normalizeShopifyShadowPolicyLifetime',
  'SHOPIFY_SHADOW_TEST_CHARGE_MODES',
  'SHOPIFY_SHADOW_TEST_SUBSIDY_REASON_MIN_LENGTH = 3',
  'SHOPIFY_SHADOW_TEST_SUBSIDY_REASON_MAX_LENGTH = 160',
  "'zero_single_service'",
  "SHOPIFY_SHADOW_POLICY_DEFAULT_LIFETIME_MODE = 'timed'",
  "'until_turned_off'",
  'SHOPIFY_SHADOW_POLICY_DEFAULT_DURATION_MINUTES = 60',
  'SHOPIFY_SHADOW_POLICY_MIN_DURATION_MINUTES = 15',
  'SHOPIFY_SHADOW_POLICY_MAX_DURATION_MINUTES = 240',
  'searchShopifyCustomers',
  'maskShopifyCustomerEmail',
  'maskShopifyCustomerEmailsInText',
  'displayName: maskShopifyCustomerEmailsInText(displayName)',
  'maskedEmail: email ? maskShopifyCustomerEmail(email) : null',
  'query: maskShopifyCustomerEmailsInText(query)',
  'customers(first: $first, after: $after, query: $query)',
  'defaultEmailAddress',
  'read_customers',
  'nodes.length > pageSize',
  'nextCursor === cursor',
], 'Shopify customer policy integration')
assert.equal(
  policyIntegration.includes('mutation '),
  false,
  'customer search integration must contain no Shopify mutation',
)
assert.equal(
  policyIntegration.includes('console.'),
  false,
  'customer search integration must not log customer PII',
)

requireAll(persistence, [
  'listShopifyCustomerRatePoliciesFromPostgres',
  'readShopifyCustomerRatePolicyFromPostgres',
  'upsertShopifyCustomerRatePolicyInPostgres',
  'removeShopifyCustomerRatePolicyInPostgres',
  'readActiveShopifyCustomerRatePolicyFromPostgres',
  'readShopifyCheckoutCustomerRatePolicyFromPostgres',
  'readShopifyCustomerRatePolicySummaryFromPostgres',
  'hasAnyShopifyCustomerRatePoliciesInPostgres',
  'readAvailableShopifyCheckoutServicesFromPostgres',
  'FOR UPDATE OF policy',
  'expectedRowVersion',
  'SHOPIFY_CUSTOMER_POLICY_ROW_VERSION_REQUIRED',
  'SHOPIFY_CUSTOMER_POLICY_STALE',
  'SHOPIFY_SHADOW_POLICY_LIFETIME_REQUIRED',
  'shadowLifetimeIsExplicit',
  'Choose timed or until turned off when updating an existing TEST customer policy',
  "SET status = 'removed'",
  'removed_at = now()',
  "activation.state = 'shadow'",
  "policy.status = 'simulated'",
  'policy.shadow_expires_at > now()',
  "activation.state = 'active'",
  "policy.status = 'enforced'",
  'providerWriteAvailable: false',
  'providerWritesPerformed: 0',
  'assertLocalPolicyMutationAllowed(context.activationState)',
  'checkoutPolicyUsesProofLane(',
  "control.rateSource === 'sandbox'",
  "accountEnvironment !== 'production'",
  'context.accountEnvironment',
  'normalizeShopifyShadowPolicyLifetime({',
  'shadowLifetimeMode: input.shadowLifetimeMode',
  'shadow_lifetime_mode',
  'expired_simulated_count',
  'until_turned_off_simulated_count',
  'shadow_allowed_count',
  "mode <> 'hide_all'",
  'shadowAllowedCount',
  'shadowTestChargeMode',
  'shadowTestServiceCode',
  'shadowTestSubsidyReason',
  'SHOPIFY_CHECKOUT_TEST_SUBSIDY_REQUIRES_TEST_SOURCE',
  'earliest_shadow_expires_at',
  'LIMIT 101',
], 'customer policy persistence')
const exactPolicyReadStart = persistence.indexOf(
  'export async function readShopifyCustomerRatePolicyFromPostgres',
)
const exactPolicyReadEnd = persistence.indexOf(
  'export async function upsertShopifyCustomerRatePolicyInPostgres',
  exactPolicyReadStart,
)
assert.ok(
  exactPolicyReadStart >= 0 && exactPolicyReadEnd > exactPolicyReadStart,
  'exact customer policy read boundary is missing',
)
const exactPolicyRead = persistence.slice(
  exactPolicyReadStart,
  exactPolicyReadEnd,
)
requireAll(exactPolicyRead, [
  'normalizeShopifyCustomerGid(input.customerGid)',
  'accountContext(null',
  'policy.integration_account_id = $2::uuid',
  'policy.shopify_customer_gid = $3',
  "AND policy.status <> 'removed'",
  'input.includeRemoved',
  'POLICY_SELECT',
], 'exact customer policy read')
for (const eligibilityFilter of [
  "activation.state = 'shadow'",
  'policy.shadow_expires_at > now()',
]) {
  assert.equal(
    exactPolicyRead.includes(eligibilityFilter),
    false,
    `exact policy edit read must retain expired evidence: ${eligibilityFilter}`,
  )
}
assert.equal(
  /DELETE\s+FROM\s+operations_shopify_customer_rate_policies/i.test(
    persistence,
  ),
  false,
  'policy removal must preserve a tombstone',
)
assert.equal(
  persistence.includes('console.'),
  false,
  'policy persistence must not log customer PII',
)

requireAll(route, [
  'const actor = await requireRequestUser(req)',
  'operationsCapabilities(actor).canManage',
  'activeOperationsOrganizationId(actor)',
  "'Cache-Control': 'private, no-store'",
  'export async function GET(req: NextRequest)',
  'export async function POST(req: NextRequest)',
  'export async function DELETE(req: NextRequest)',
  "action === 'upsert'",
  "action === 'remove'",
  "action === 'search'",
  'providerCustomerSearch',
  'normalizeShopifyCustomerSearchQuery(body.search)',
  "storedCredential.authMode !== 'shopify_client_credentials'",
  'requestShopifyAccessToken',
  'shopifyAdminGraphql',
  'availableServices',
  'availableServicesTruncated',
  'shadowDurationMinutes',
  'shadowLifetimeMode',
  'shadowTestChargeMode',
  'shadowTestServiceCode',
  'shadowTestSubsidyReason',
  'supportedLifetimeModes',
  'untilTurnedOffSimulatedCount',
  'shadowPolicyLimits',
  'expiredSimulatedCount',
  'earliestShadowExpiresAt',
  'expectedRowVersion',
  "req.nextUrl.searchParams.get('customerGid')",
  'customerGid !== null',
  'readShopifyCustomerRatePolicyFromPostgres({',
  'includeRemoved,',
  "...(customerGid !== null ? { policy: exactPolicy } : {})",
  'maskShopifyCustomerEmailsInText(normalizedSearch)',
  'error: maskShopifyCustomerEmailsInText(error.message)',
  'error: maskShopifyCustomerEmailsInText(sanitized.message)',
], 'customer policy API route')

const customerSearchResponseStart = route.indexOf(
  'async function customerSearchResponse',
)
const customerSearchResponseEnd = route.indexOf(
  'export async function GET',
  customerSearchResponseStart,
)
assert.ok(
  customerSearchResponseStart >= 0
    && customerSearchResponseEnd > customerSearchResponseStart,
  'POST customer-search response boundary is missing',
)
const customerSearchResponse = route.slice(
  customerSearchResponseStart,
  customerSearchResponseEnd,
)
requireAll(customerSearchResponse, [
  "'action'",
  "'accountGlobalId'",
  "'search'",
  "'customerCursor'",
  "'customerPageSize'",
  'organizationId: context.organizationId',
  "accountGlobalId: String(body.accountGlobalId || '')",
  'search: normalizedSearch',
  'cursor: body.customerCursor',
  'pageSize: optionalInteger(body.customerPageSize)',
  "'SHOPIFY_CUSTOMER_SEARCH_REQUIRED'",
  "'Enter a Shopify customer name, email, or Customer GID to search'",
  'query: result.query',
  'query: maskedSearch',
  'safeCustomerSearchError(error)',
], 'read-only POST customer search')
const emptySearchGuard = customerSearchResponse.indexOf(
  "if (!normalizedSearch)",
)
const providerSearchCall = customerSearchResponse.indexOf(
  'await providerCustomerSearch({',
)
assert.ok(
  emptySearchGuard >= 0 && providerSearchCall > emptySearchGuard,
  'empty POST customer search must fail before account/provider lookup',
)
assert.equal(
  customerSearchResponse.includes('queried: false'),
  false,
  'empty POST customer search must not return an unscoped success envelope',
)
requireAll(route, [
  "value === undefined || value === null || value === ''",
], 'optional customer-search integer parsing')
for (const customerSearchWrite of [
  'upsertShopifyCustomerRatePolicyInPostgres',
  'removeShopifyCustomerRatePolicyInPostgres',
  'mutation ',
]) {
  assert.equal(
    customerSearchResponse.includes(customerSearchWrite),
    false,
    `POST customer search must remain read-only: ${customerSearchWrite}`,
  )
}

const getStart = route.indexOf('export async function GET')
const postStart = route.indexOf('export async function POST', getStart)
assert.ok(
  getStart >= 0 && postStart > getStart,
  'customer policy GET boundary is missing',
)
const getHandler = route.slice(getStart, postStart)
for (const forbiddenGetSearch of [
  "searchParams.get('search')",
  "searchParams.get('customerCursor')",
  "searchParams.get('customerPageSize')",
  'providerCustomerSearch(',
]) {
  assert.equal(
    getHandler.includes(forbiddenGetSearch),
    false,
    `GET must not accept raw provider-search input: ${forbiddenGetSearch}`,
  )
}
for (const providerMutation of [
  'metafieldsSet',
  'customerUpdate',
  'customerDelete',
]) {
  assert.equal(
    route.includes(providerMutation),
    false,
    `customer policy API must not contain ${providerMutation}`,
  )
}
assert.equal(
  route.includes('console.'),
  false,
  'customer policy API must not log customer PII',
)

const policy = loadPolicyModule()
assert.equal(policy.SHOPIFY_SHADOW_POLICY_DEFAULT_DURATION_MINUTES, 60)
assert.equal(policy.SHOPIFY_SHADOW_POLICY_MIN_DURATION_MINUTES, 15)
assert.equal(policy.SHOPIFY_SHADOW_POLICY_MAX_DURATION_MINUTES, 240)
assert.equal(policy.SHOPIFY_SHADOW_POLICY_DEFAULT_LIFETIME_MODE, 'timed')
assert.equal(policy.normalizeShopifyShadowPolicyDurationMinutes(undefined), 60)
assert.equal(policy.normalizeShopifyShadowPolicyDurationMinutes(''), 60)
assert.equal(policy.normalizeShopifyShadowPolicyDurationMinutes(15), 15)
assert.equal(policy.normalizeShopifyShadowPolicyDurationMinutes(240), 240)
for (const invalidDuration of [14, 241, 60.5, 'invalid']) {
  assert.throws(
    () => policy.normalizeShopifyShadowPolicyDurationMinutes(invalidDuration),
    (error) => error.code === 'SHOPIFY_SHADOW_POLICY_DURATION_INVALID',
  )
}
assert.deepEqual(
  plain(policy.normalizeShopifyShadowPolicyLifetime({})),
  { shadowLifetimeMode: 'timed', shadowDurationMinutes: 60 },
)
assert.deepEqual(
  plain(policy.normalizeShopifyShadowPolicyLifetime({
    shadowLifetimeMode: 'timed',
    shadowDurationMinutes: 15,
  })),
  { shadowLifetimeMode: 'timed', shadowDurationMinutes: 15 },
)
assert.deepEqual(
  plain(policy.normalizeShopifyShadowPolicyLifetime({
    shadowLifetimeMode: 'until_turned_off',
  })),
  { shadowLifetimeMode: 'until_turned_off', shadowDurationMinutes: null },
)
for (const invalidLifetime of [
  { shadowLifetimeMode: 'forever' },
  {
    shadowLifetimeMode: 'until_turned_off',
    shadowDurationMinutes: 60,
  },
]) {
  assert.throws(
    () => policy.normalizeShopifyShadowPolicyLifetime(invalidLifetime),
    (error) => error.code === 'SHOPIFY_SHADOW_POLICY_LIFETIME_INVALID',
  )
}
assert.equal(
  policy.normalizeShopifyCustomerGid('1234567890'),
  'gid://shopify/Customer/1234567890',
)
assert.equal(
  policy.normalizeShopifyCustomerGid(
    'gid://shopify/Customer/1234567890',
  ),
  'gid://shopify/Customer/1234567890',
)
assert.throws(
  () => policy.normalizeShopifyCustomerGid('gid://shopify/Order/123'),
  (error) => error.code === 'SHOPIFY_CUSTOMER_GID_INVALID',
)

assert.deepEqual(
  plain(policy.normalizeShopifyCustomerRatePolicy({
    mode: 'show_all',
    serviceCodes: [],
  })),
  {
    version: 2,
    mode: 'show_all',
    serviceCodes: [],
    shadowTestChargeMode: 'carrier_rate',
    shadowTestServiceCode: null,
    shadowTestSubsidyReason: null,
  },
)
assert.deepEqual(
  plain(policy.normalizeShopifyCustomerRatePolicy({
    mode: 'include_only',
    serviceCodes: [
      'clawpilot:ups:03',
      'clawpilot:fedex:fedex_ground',
    ],
  })),
  {
    version: 2,
    mode: 'include_only',
    serviceCodes: [
      'clawpilot:fedex:fedex_ground',
      'clawpilot:ups:03',
    ],
    shadowTestChargeMode: 'carrier_rate',
    shadowTestServiceCode: null,
    shadowTestSubsidyReason: null,
  },
)
assert.deepEqual(
  plain(policy.normalizeShopifyCustomerRatePolicy({
    mode: 'include_only',
    serviceCodes: ['clawpilot:ups:03'],
    shadowTestChargeMode: 'zero_single_service',
    shadowTestServiceCode: ' CLAWPILOT:UPS:03 ',
    shadowTestSubsidyReason: ' Test checkout without card collection ',
  })),
  {
    version: 2,
    mode: 'include_only',
    serviceCodes: ['clawpilot:ups:03'],
    shadowTestChargeMode: 'zero_single_service',
    shadowTestServiceCode: 'clawpilot:ups:03',
    shadowTestSubsidyReason: 'Test checkout without card collection',
  },
)
for (const invalidChargePolicy of [
  {
    mode: 'show_all',
    serviceCodes: [],
    shadowTestChargeMode: 'carrier_rate',
    shadowTestServiceCode: 'clawpilot:ups:03',
  },
  {
    mode: 'hide_all',
    serviceCodes: [],
    shadowTestChargeMode: 'zero_single_service',
    shadowTestServiceCode: 'clawpilot:ups:03',
    shadowTestSubsidyReason: 'Hidden service must not receive a subsidy',
  },
  {
    mode: 'show_all',
    serviceCodes: [],
    shadowTestChargeMode: 'zero_single_service',
    shadowTestServiceCode: 'clawpilot:ups:03',
    shadowTestSubsidyReason: 'x'.repeat(161),
  },
  {
    mode: 'show_all',
    serviceCodes: [],
    shadowTestChargeMode: 'zero_single_service',
    shadowTestServiceCode: 'clawpilot:ups:03',
    shadowTestSubsidyReason: 'x',
  },
]) {
  assert.throws(
    () => policy.normalizeShopifyCustomerRatePolicy(invalidChargePolicy),
    (error) => String(error.code).startsWith('SHOPIFY_SHADOW_TEST_'),
  )
}
assert.throws(
  () => policy.normalizeShopifyCustomerRatePolicy({
    mode: 'hide_all',
    serviceCodes: ['clawpilot:ups:03'],
  }),
  (error) => (
    error.code === 'SHOPIFY_CUSTOMER_RATE_POLICY_SERVICE_CODES_INVALID'
  ),
)
assert.throws(
  () => policy.normalizeShopifyCustomerRatePolicy({
    mode: 'exclude',
    serviceCodes: Array.from(
      { length: 51 },
      (_, index) => `clawpilot:ups:service_${index}`,
    ),
  }),
  (error) => (
    error.code
      === 'SHOPIFY_CUSTOMER_RATE_POLICY_SERVICE_CODES_LIMIT_EXCEEDED'
  ),
)

assert.equal(
  policy.maskShopifyCustomerEmail('buyer@example.com'),
  'b***@example.com',
)
assert.equal(
  policy.maskShopifyCustomerEmailsInText(
    'email:buyer@example.com state:enabled',
  ),
  'email:b***@example.com state:enabled',
)

const graphqlCalls = []
const searchResult = await policy.searchShopifyCustomers({
  credential: {
    shopDomain: 'example.myshopify.com',
    accessToken: 'test-token',
  },
  grantedScopes: ['read_customers'],
  search: '  buyer@example.com  ',
  cursor: 'cursor-1',
  pageSize: 2,
  graphql: async (credential, request, options) => {
    graphqlCalls.push({ credential, request, options })
    return {
      customers: {
        nodes: [
          {
            id: 'gid://shopify/Customer/1234567890',
            displayName: 'buyer@example.com',
            defaultEmailAddress: { emailAddress: 'buyer@example.com' },
            state: 'ENABLED',
          },
          {
            id: 'gid://shopify/Customer/2345678901',
            displayName: 'Second Buyer',
            defaultEmailAddress: null,
            state: 'DISABLED',
          },
        ],
        pageInfo: {
          hasNextPage: true,
          endCursor: 'cursor-2',
        },
      },
    }
  },
})
assert.deepEqual(plain(searchResult), {
  customers: [
    {
      customerGid: 'gid://shopify/Customer/1234567890',
      displayName: 'b***@example.com',
      maskedEmail: 'b***@example.com',
      state: 'ENABLED',
    },
    {
      customerGid: 'gid://shopify/Customer/2345678901',
      displayName: 'Second Buyer',
      maskedEmail: null,
      state: 'DISABLED',
    },
  ],
  query: 'b***@example.com',
  nextCursor: 'cursor-2',
  hasNextPage: true,
})
assert.deepEqual(plain(graphqlCalls[0].request.variables), {
  first: 2,
  after: 'cursor-1',
  query: 'buyer@example.com',
})
assert.equal(
  Object.hasOwn(searchResult.customers[0], 'email'),
  false,
  'customer search responses must not expose an unmasked email field',
)
assert.equal(
  JSON.stringify(searchResult).includes('buyer@example.com'),
  false,
  'customer search responses must not include the raw provider email',
)
assert.equal(
  graphqlCalls[0].request.operationName,
  'ClawPilotCustomerRatePolicySearch',
)
assert.equal(graphqlCalls[0].options.timeoutMs, 10_000)

await assert.rejects(
  policy.searchShopifyCustomers({
    credential: {
      shopDomain: 'example.myshopify.com',
      accessToken: 'test-token',
    },
    grantedScopes: ['read_orders'],
    graphql: async () => ({ customers: null }),
  }),
  (error) => error.code === 'SHOPIFY_READ_CUSTOMERS_SCOPE_REQUIRED',
)
await assert.rejects(
  policy.searchShopifyCustomers({
    credential: {
      shopDomain: 'example.myshopify.com',
      accessToken: 'test-token',
    },
    grantedScopes: ['read_customers'],
    cursor: 'same-cursor',
    graphql: async () => ({
      customers: {
        nodes: [],
        pageInfo: {
          hasNextPage: true,
          endCursor: 'same-cursor',
        },
      },
    }),
  }),
  (error) => error.code === 'SHOPIFY_CUSTOMER_SEARCH_CURSOR_INVALID',
)

console.log('Shopify customer rate policy contracts passed')
