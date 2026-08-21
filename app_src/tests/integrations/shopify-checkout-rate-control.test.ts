import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeShopifyCheckoutRateControl,
  readShopifyCheckoutRateControl,
  shopifyCheckoutRateControlCanServe,
  shopifyCheckoutRateControlEmptyReason,
  ShopifyCheckoutRateControlError,
} from '../../lib/operations/shopifyCheckoutRateControl.ts'
import {
  shopifyCustomerRatePolicyAllowsService,
} from '../../lib/integrations/shopifyCustomerRatePolicy.ts'
import {
  ShopifyCheckoutRateControlHttpError,
  assertShopifyCheckoutRateControlCommandResult,
  normalizeShopifyCheckoutRateControlPendingCommand,
  persistShopifyCheckoutRateControlPendingCommand,
  readShopifyCheckoutRateControlPendingCommand,
  selectShopifyCheckoutRateControlFormState,
  shopifyCheckoutRateControlPendingResolution,
} from '../../lib/operations/shopifyCheckoutRateControlCommand.ts'

test('accepts every exact audience and source pair', () => {
  for (const audience of [
    'off',
    'restricted_customers',
    'all_eligible',
  ] as const) {
    for (const rateSource of ['sandbox', 'production'] as const) {
      assert.deepEqual(
        normalizeShopifyCheckoutRateControl({
          version: 'shopify-checkout-rate-control-v1',
          audience,
          rateSource,
        }),
        {
          version: 'shopify-checkout-rate-control-v1',
          audience,
          rateSource,
        },
      )
    }
  }
})

test('rejects malformed, extended, and unsupported controls', () => {
  for (const value of [
    null,
    [],
    {},
    {
      version: 'shopify-checkout-rate-control-v2',
      audience: 'off',
      rateSource: 'sandbox',
    },
    {
      version: 'shopify-checkout-rate-control-v1',
      audience: 'everyone',
      rateSource: 'sandbox',
    },
    {
      version: 'shopify-checkout-rate-control-v1',
      audience: ['off'],
      rateSource: 'sandbox',
    },
    {
      version: 'shopify-checkout-rate-control-v1',
      audience: 'off',
      rateSource: 'staging',
    },
    {
      version: 'shopify-checkout-rate-control-v1',
      audience: 'off',
      rateSource: 'sandbox',
      extra: true,
    },
  ]) {
    assert.throws(
      () => normalizeShopifyCheckoutRateControl(value),
      (error: unknown) => (
        error instanceof ShopifyCheckoutRateControlError
        && error.code === 'SHOPIFY_CHECKOUT_RATE_CONTROL_INVALID'
      ),
    )
  }
})

test('legacy fallback is fail-closed for audience and never derives sandbox for production', () => {
  assert.deepEqual(
    readShopifyCheckoutRateControl({}, {
      activationState: 'shadow',
      accountEnvironment: 'sandbox',
    }),
    {
      version: 'shopify-checkout-rate-control-v1',
      audience: 'restricted_customers',
      rateSource: 'sandbox',
    },
  )
  assert.equal(
    readShopifyCheckoutRateControl({}, {
      activationState: 'read_only',
      accountEnvironment: 'production',
    }).rateSource,
    'production',
  )
})

test('emergency states, Off, unsafe source, and unverified production Restricted cannot serve', () => {
  const base = {
    version: 'shopify-checkout-rate-control-v1' as const,
    audience: 'all_eligible' as const,
    rateSource: 'production' as const,
  }
  for (const activationState of ['disabled', 'frozen'] as const) {
    assert.equal(shopifyCheckoutRateControlCanServe({
      control: base,
      activationState,
      accountEnvironment: 'production',
    }), false)
  }
  assert.equal(shopifyCheckoutRateControlCanServe({
    control: { ...base, audience: 'off' },
    activationState: 'read_only',
    accountEnvironment: 'production',
  }), false)
  assert.equal(shopifyCheckoutRateControlCanServe({
    control: { ...base, rateSource: 'sandbox' },
    activationState: 'read_only',
    accountEnvironment: 'production',
  }), false)
  assert.equal(shopifyCheckoutRateControlEmptyReason({
    control: { ...base, rateSource: 'sandbox' },
    activationState: 'read_only',
    accountEnvironment: 'production',
  }), 'SHOPIFY_CHECKOUT_PRODUCTION_RATE_SOURCE_REQUIRED')
  const restricted = { ...base, audience: 'restricted_customers' as const }
  assert.equal(shopifyCheckoutRateControlCanServe({
    control: restricted,
    activationState: 'read_only',
    accountEnvironment: 'production',
  }), false)
  assert.equal(shopifyCheckoutRateControlEmptyReason({
    control: restricted,
    activationState: 'read_only',
    accountEnvironment: 'production',
  }), 'SHOPIFY_CHECKOUT_RESTRICTED_LIVE_ENFORCEMENT_REQUIRED')
  assert.equal(shopifyCheckoutRateControlCanServe({
    control: restricted,
    activationState: 'read_only',
    accountEnvironment: 'sandbox',
  }), false)
  assert.equal(shopifyCheckoutRateControlCanServe({
    control: { ...restricted, rateSource: 'sandbox' },
    activationState: 'read_only',
    accountEnvironment: 'sandbox',
  }), true)
  assert.equal(shopifyCheckoutRateControlCanServe({
    control: base,
    activationState: 'read_only',
    accountEnvironment: 'production',
  }), true)
})

test('restricted customer policy filters exact stable checkout service codes', () => {
  const upsGround = 'clawpilot:ups:ground'
  const upsAir = 'clawpilot:ups:next_day_air'
  assert.equal(shopifyCustomerRatePolicyAllowsService({
    mode: 'show_all',
    serviceCodes: [],
  }, upsGround), true)
  assert.equal(shopifyCustomerRatePolicyAllowsService({
    mode: 'hide_all',
    serviceCodes: [],
  }, upsGround), false)
  assert.equal(shopifyCustomerRatePolicyAllowsService({
    mode: 'include_only',
    serviceCodes: [upsGround],
  }, upsGround), true)
  assert.equal(shopifyCustomerRatePolicyAllowsService({
    mode: 'include_only',
    serviceCodes: [upsGround],
  }, upsAir), false)
  assert.equal(shopifyCustomerRatePolicyAllowsService({
    mode: 'exclude',
    serviceCodes: [upsGround],
  }, upsGround), false)
  assert.equal(shopifyCustomerRatePolicyAllowsService({
    mode: 'exclude',
    serviceCodes: [upsGround],
  }, upsAir), true)
})

test('lost response recovery persists and reads back the exact retry command before reconciliation', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
  }
  const key = 'checkout-rate-control:gia2930001'
  const command = {
    accountGlobalId: 'gia2930001',
    actorEmail: 'owner@example.test',
    configGlobalId: 'gscf2930001',
    idempotencyKey: 'shopify-rate-control:11111111-1111-4111-8111-111111111111',
    expectedPolicyRevision: 4,
    body: {
      expectedConfigGlobalId: 'gscf2930001',
      expectedRowVersion: 7,
      expectedPolicyRevision: 4,
      checkoutRateControl: {
        version: 'shopify-checkout-rate-control-v1' as const,
        audience: 'restricted_customers' as const,
        rateSource: 'production' as const,
      },
      reason: 'Serve the approved production checkout audience',
    },
  }
  const persisted = persistShopifyCheckoutRateControlPendingCommand(
    storage,
    key,
    command,
  )
  assert.deepEqual(persisted, command)
  assert.deepEqual(
    readShopifyCheckoutRateControlPendingCommand(storage, key),
    command,
    'a remounted browser session must recover the same key and body',
  )
  assert.deepEqual(
    selectShopifyCheckoutRateControlFormState({
      accountGlobalId: command.accountGlobalId,
      actorEmail: command.actorEmail,
      configGlobalId: command.configGlobalId,
      serverControl: {
        version: 'shopify-checkout-rate-control-v1',
        audience: 'all_eligible',
        rateSource: 'sandbox',
      },
      pendingCommand: command,
    }),
    {
      checkoutRateControl: command.body.checkoutRateControl,
      reason: command.body.reason,
    },
    'a delayed setup GET must keep the exact pending body visibly applied',
  )

  const wrongResult = {
    version: 'shopify-checkout-rate-control-command-result-v1',
    accountGlobalId: 'gia2930002',
    configGlobalId: 'gscf2930001',
    idempotencyKey: command.idempotencyKey,
    requestHash: 'a'.repeat(64),
    checkoutRateControl: command.body.checkoutRateControl,
    rowVersion: 8,
    policyRevision: 5,
    providerWrites: 0,
  }
  assert.throws(() => assertShopifyCheckoutRateControlCommandResult({
    value: wrongResult,
    command,
    accountGlobalId: 'gia2930001',
    configGlobalId: 'gscf2930001',
  }), /mismatched checkout-rate control result/u)
  assert.deepEqual(
    readShopifyCheckoutRateControlPendingCommand(storage, key),
    command,
    'a malformed or cross-account 200 must not clear exact replay state',
  )

  assert.deepEqual(assertShopifyCheckoutRateControlCommandResult({
    value: { ...wrongResult, accountGlobalId: 'gia2930001' },
    command,
    accountGlobalId: 'gia2930001',
    configGlobalId: 'gscf2930001',
  }), { ...wrongResult, accountGlobalId: 'gia2930001' })

  assert.throws(() => selectShopifyCheckoutRateControlFormState({
    accountGlobalId: 'gia2930002',
    actorEmail: command.actorEmail,
    configGlobalId: 'gscf2930002',
    serverControl: {
      version: 'shopify-checkout-rate-control-v1',
      audience: 'off',
      rateSource: 'sandbox',
    },
    pendingCommand: command,
  }), /different Shopify account/u)
  assert.deepEqual(selectShopifyCheckoutRateControlFormState({
    accountGlobalId: 'gia2930002',
    actorEmail: command.actorEmail,
    configGlobalId: 'gscf2930002',
    serverControl: {
      version: 'shopify-checkout-rate-control-v1',
      audience: 'all_eligible',
      rateSource: 'production',
    },
    pendingCommand: null,
  }), {
    checkoutRateControl: {
      version: 'shopify-checkout-rate-control-v1',
      audience: 'all_eligible',
      rateSource: 'production',
    },
    reason: null,
  }, 'switching from account A pending to account B must expose only B state')
})

test('pending command persistence fails before POST when durable read-back drifts', () => {
  const storage = {
    getItem() {
      return '{"corrupt":true}'
    },
    setItem() {},
  }
  assert.throws(() => persistShopifyCheckoutRateControlPendingCommand(
    storage,
    'checkout-rate-control:gia2930001',
    {
      accountGlobalId: 'gia2930001',
      actorEmail: 'owner@example.test',
      configGlobalId: 'gscf2930001',
      idempotencyKey: 'shopify-rate-control:22222222-2222-4222-8222-222222222222',
      expectedPolicyRevision: 1,
      body: {
        expectedConfigGlobalId: 'gscf2930001',
        expectedRowVersion: 1,
        expectedPolicyRevision: 1,
        checkoutRateControl: {
          version: 'shopify-checkout-rate-control-v1',
          audience: 'off',
          rateSource: 'sandbox',
        },
        reason: 'Pause checkout rates',
      },
    },
  ), /was not retained/u)
})

test('pending command rejects actor and expanded fence drift before POST', () => {
  const command = {
    accountGlobalId: 'gia2930001',
    actorEmail: 'owner@example.test',
    configGlobalId: 'gscf2930001',
    idempotencyKey: 'shopify-rate-control:55555555-5555-4555-8555-555555555555',
    expectedPolicyRevision: 4,
    body: {
      expectedConfigGlobalId: 'gscf2930001',
      expectedRowVersion: 7,
      expectedPolicyRevision: 4,
      checkoutRateControl: {
        version: 'shopify-checkout-rate-control-v1' as const,
        audience: 'all_eligible' as const,
        rateSource: 'production' as const,
      },
      reason: 'Bind exact actor and configuration fences',
    },
  }
  assert.deepEqual(
    normalizeShopifyCheckoutRateControlPendingCommand(command),
    command,
  )
  for (const malformed of [
    { ...command, actorEmail: 'Replacement@Example.test' },
    {
      ...command,
      body: { ...command.body, expectedConfigGlobalId: 'gscf2930002' },
    },
    {
      ...command,
      body: { ...command.body, expectedPolicyRevision: 5 },
    },
  ]) {
    assert.throws(
      () => normalizeShopifyCheckoutRateControlPendingCommand(malformed),
      /invalid/u,
    )
  }
})

test('checkout-rate pending recovery distinguishes applied, definitive, and ambiguous outcomes', () => {
  const command = {
    accountGlobalId: 'gia2930001',
    actorEmail: 'owner@example.test',
    configGlobalId: 'gscf2930001',
    idempotencyKey: 'shopify-rate-control:33333333-3333-4333-8333-333333333333',
    expectedPolicyRevision: 4,
    body: {
      expectedConfigGlobalId: 'gscf2930001',
      expectedRowVersion: 7,
      expectedPolicyRevision: 4,
      checkoutRateControl: {
        version: 'shopify-checkout-rate-control-v1' as const,
        audience: 'all_eligible' as const,
        rateSource: 'production' as const,
      },
      reason: 'Serve every eligible checkout from live carrier accounts',
    },
  }
  const appliedState = {
    accountGlobalId: command.accountGlobalId,
    configGlobalId: command.configGlobalId,
    checkoutRateControl: command.body.checkoutRateControl,
    rowVersion: command.body.expectedRowVersion + 1,
    policyRevision: command.expectedPolicyRevision + 1,
    canEdit: true,
    lastChange: {
      configGlobalId: command.configGlobalId,
      idempotencyKey: command.idempotencyKey,
      requestHash: 'b'.repeat(64),
      actorEmail: command.actorEmail,
      requestedControl: command.body.checkoutRateControl,
      resultingRowVersion: command.body.expectedRowVersion + 1,
      resultingPolicyRevision: command.expectedPolicyRevision + 1,
      reason: command.body.reason,
    },
  }
  assert.equal(shopifyCheckoutRateControlPendingResolution({
    state: appliedState,
    command,
    failure: new TypeError('fetch failed'),
  }), 'applied', 'a lost response reconciles only the exact committed state')

  const unchangedState = {
    ...appliedState,
    rowVersion: command.body.expectedRowVersion,
    policyRevision: command.expectedPolicyRevision,
    lastChange: null,
  }
  for (const failure of [
    new TypeError('fetch failed'),
    new ShopifyCheckoutRateControlHttpError(429, 'Try again later'),
    new ShopifyCheckoutRateControlHttpError(503, 'Unavailable'),
    new Error('Mismatched 200 response'),
  ]) {
    assert.equal(shopifyCheckoutRateControlPendingResolution({
      state: unchangedState,
      command,
      failure,
    }), 'retain_exact_retry')
  }

  assert.equal(shopifyCheckoutRateControlPendingResolution({
    state: {
      ...appliedState,
      lastChange: {
        ...appliedState.lastChange,
        idempotencyKey:
          'shopify-rate-control:44444444-4444-4444-8444-444444444444',
      },
    },
    command,
    failure: new TypeError('fetch failed'),
  }), 'superseded', 'matching values without exact receipt lineage must quarantine the retry')

  for (const status of [400, 401, 403, 404, 409, 410, 422]) {
    assert.equal(shopifyCheckoutRateControlPendingResolution({
      state: {
        ...appliedState,
        checkoutRateControl: {
          ...command.body.checkoutRateControl,
          audience: 'off',
        },
      },
      command,
      failure: new ShopifyCheckoutRateControlHttpError(
        status,
        'The saved policy changed before this request',
        status === 409 ? 'SHOPIFY_CHECKOUT_RATE_CONTROL_CONFLICT' : null,
      ),
    }), 'definitive_rejection')
  }
})
