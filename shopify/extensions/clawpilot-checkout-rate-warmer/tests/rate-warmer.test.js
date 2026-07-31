import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CartChangedError,
  RATE_WARM_STATUS_EVENT,
  cartUrl,
  createDebouncer,
  dedupeZones,
  dispatchRateWarmStatus,
  fetchWarmPolicy,
  normalizePolicy,
  processZones,
  proxyPolicyUrl,
  shippingRateUrl,
  warmAllZones,
  warmShippingZone,
} from '../src/rate-warmer.js'

const FINGERPRINT = 'a'.repeat(64)

function policy(overrides = {}) {
  return {
    version: 1,
    enabled: true,
    mode: 'hosted_ajax',
    policyRevision: 7,
    cartFingerprint: FINGERPRINT,
    concurrency: 2,
    debounceMs: 350,
    minIntervalMs: 1_000,
    staleCartAbort: true,
    zones: [
      { countryCode: 'US', provinceCode: 'CT', postalCode: '06611' },
    ],
    coverage: {
      scanned: 4,
      eligible: 3,
      duplicate: 1,
      invalid: 0,
      unsupported: 0,
    },
    ...overrides,
  }
}

test('debouncer executes only the latest scheduled callback', () => {
  const timers = new Map()
  const cleared = []
  let nextId = 0
  const debouncer = createDebouncer({
    setTimer(callback, delay) {
      nextId += 1
      timers.set(nextId, { callback, delay })
      return nextId
    },
    clearTimer(id) {
      cleared.push(id)
      timers.delete(id)
    },
  })
  const calls = []

  debouncer.schedule(() => calls.push('first'), 200)
  debouncer.schedule(() => calls.push('second'), 425)

  assert.deepEqual(cleared, [1])
  assert.equal(timers.size, 1)
  const pending = [...timers.values()][0]
  assert.equal(pending.delay, 425)
  pending.callback()
  assert.deepEqual(calls, ['second'])
})

test('cart fingerprint change aborts before another zone begins', async () => {
  const controller = new AbortController()
  let fingerprintReads = 0
  const started = []
  const twoZones = policy({
    concurrency: 1,
    zones: [
      { countryCode: 'US', provinceCode: 'CT', postalCode: '06611' },
      { countryCode: 'US', provinceCode: 'CA', postalCode: '92647' },
    ],
  })

  await assert.rejects(
    warmAllZones({
      policy: twoZones,
      expectedFingerprint: FINGERPRINT,
      controller,
      readFingerprint: async () => {
        fingerprintReads += 1
        return fingerprintReads === 1 ? FINGERPRINT : 'b'.repeat(64)
      },
      warmZone: async ({ zone, guard }) => {
        started.push(zone.postalCode)
        await guard()
        await guard()
      },
    }),
    (error) => error instanceof CartChangedError,
  )

  assert.equal(controller.signal.aborted, true)
  assert.deepEqual(started, ['06611'])
})

test('all deduplicated zones run and an ordinary zone error is isolated', async () => {
  const seen = []
  const zones = [
    { countryCode: 'us', provinceCode: 'ct', postalCode: ' 06611 ' },
    { countryCode: 'US', provinceCode: 'CT', postalCode: '06611' },
    { countryCode: 'US', provinceCode: 'CA', postalCode: '92647' },
    { countryCode: 'CA', provinceCode: 'ON', postalCode: 'm5v 2t6' },
  ]

  const results = await processZones(zones, 2, async (zone) => {
    seen.push(`${zone.countryCode}:${zone.postalCode}`)
    if (zone.postalCode === '92647') throw new Error('zone unavailable')
    return zone.postalCode
  })

  assert.deepEqual(seen.sort(), [
    'CA:M5V 2T6',
    'US:06611',
    'US:92647',
  ])
  assert.equal(results.length, 3)
  assert.equal(results.filter((result) => result.ok).length, 2)
  assert.equal(results.filter((result) => !result.ok).length, 1)
})

test('zone identity is country plus postal with deterministic province hint', () => {
  const values = [
    { countryCode: 'US', provinceCode: 'NY', postalCode: '90210' },
    { countryCode: 'us', provinceCode: 'CA', postalCode: ' 90210 ' },
  ]
  const expected = [
    { countryCode: 'US', provinceCode: 'CA', postalCode: '90210' },
  ]

  assert.deepEqual(dedupeZones(values), expected)
  assert.deepEqual(dedupeZones([...values].reverse()), expected)
})

test('bounded workers process every returned zone without slicing', async () => {
  const zones = Array.from({ length: 300 }, (_, index) => ({
    countryCode: 'US',
    provinceCode: 'CT',
    postalCode: `ZONE-${String(index).padStart(3, '0')}`,
  }))
  const seen = new Set()
  let active = 0
  let maximumActive = 0
  const results = await processZones(zones, 4, async (zone) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    seen.add(zone.postalCode)
    await Promise.resolve()
    active -= 1
  })

  assert.equal(results.length, 300)
  assert.equal(seen.size, 300)
  assert.equal(maximumActive, 4)
})

test('locale-aware cart and shipping-rate URLs use Shopify Ajax fields', () => {
  assert.equal(cartUrl('/fr-ca/'), '/fr-ca/cart.js')
  const prepare = new URL(
    shippingRateUrl('/fr-ca/', 'prepare', {
      countryCode: 'ca',
      provinceCode: 'qc',
      postalCode: 'h2x 1y4',
    }),
    'https://store.example',
  )
  assert.equal(prepare.pathname, '/fr-ca/cart/prepare_shipping_rates.json')
  assert.equal(prepare.searchParams.get('shipping_address[country]'), 'CA')
  assert.equal(prepare.searchParams.get('shipping_address[province]'), 'QC')
  assert.equal(prepare.searchParams.get('shipping_address[zip]'), 'H2X 1Y4')

  const asynchronous = new URL(
    shippingRateUrl('/', 'async', {
      countryCode: 'US',
      provinceCode: null,
      postalCode: '06611',
    }),
    'https://store.example',
  )
  assert.equal(asynchronous.pathname, '/cart/async_shipping_rates.json')
  assert.equal(
    asynchronous.searchParams.has('shipping_address[province]'),
    false,
  )
})

test('app-proxy URL is same-origin and contains only minimized cart facts', () => {
  const url = proxyPolicyUrl(
    'https://store.example',
    '/apps/clawpilot/checkout-rate-warmer',
    FINGERPRINT,
    'usd',
  )
  assert.equal(
    url,
    `/apps/clawpilot/checkout-rate-warmer?cart_fingerprint=${FINGERPRINT}&cart_currency=USD`,
  )
  assert.throws(() => proxyPolicyUrl(
    'https://store.example',
    'https://attacker.example/apps/clawpilot',
    FINGERPRINT,
    'USD',
  ))
  assert.throws(() => proxyPolicyUrl(
    'https://store.example',
    '//attacker.example/apps/clawpilot',
    FINGERPRINT,
    'USD',
  ))
  assert.throws(() => proxyPolicyUrl(
    'https://store.example',
    '/apps/../admin',
    FINGERPRINT,
    'USD',
  ))
})

test('policy responses fail closed on disabled or mismatched state', () => {
  assert.equal(normalizePolicy(policy({ enabled: false }), FINGERPRINT), null)
  assert.equal(
    normalizePolicy(policy({ cartFingerprint: 'b'.repeat(64) }), FINGERPRINT),
    null,
  )
  assert.equal(
    normalizePolicy(policy({ staleCartAbort: false }), FINGERPRINT),
    null,
  )
  assert.equal(normalizePolicy(policy({ coverage: undefined }), FINGERPRINT), null)
  const normalized = normalizePolicy(policy(), FINGERPRINT)
  assert.equal(normalized?.zones.length, 1)
  assert.deepEqual(normalized?.coverage, {
    scanned: 4,
    eligible: 3,
    duplicate: 1,
    invalid: 0,
    unsupported: 0,
  })
})

test('aggregate status event exposes counts without zones or private facts', () => {
  const events = []
  class TestCustomEvent {
    constructor(type, options) {
      this.type = type
      this.detail = options.detail
    }
  }
  const windowObject = {
    CustomEvent: TestCustomEvent,
    dispatchEvent(event) {
      events.push(event)
    },
  }
  const results = [
    {
      ok: true,
      zone: { countryCode: 'US', provinceCode: 'CT', postalCode: '06611' },
      value: [{ name: 'Private carrier fact' }],
    },
    {
      ok: false,
      zone: { countryCode: 'US', provinceCode: 'CA', postalCode: '90210' },
      error: new Error('Private provider failure'),
    },
  ]

  assert.equal(dispatchRateWarmStatus(windowObject, {
    status: 'completed',
    coverage: policy().coverage,
    results,
  }), true)
  assert.equal(events[0].type, RATE_WARM_STATUS_EVENT)
  assert.deepEqual(events[0].detail, {
    version: 1,
    status: 'completed',
    coverage: {
      scanned: 4,
      eligible: 3,
      duplicate: 1,
      invalid: 0,
      unsupported: 0,
    },
    zones: { attempted: 2, succeeded: 1, failed: 1 },
    runs: { completed: 1, failed: 0, aborted: 0 },
  })
  const serialized = JSON.stringify(events[0].detail)
  assert.equal(serialized.includes('06611'), false)
  assert.equal(serialized.includes('90210'), false)
  assert.equal(serialized.includes('Private'), false)
  assert.equal(dispatchRateWarmStatus(windowObject, {
    status: 'completed',
    coverage: { ...policy().coverage, scanned: -1 },
    results,
  }), false)
})

test('non-success proxy responses return no policy', async () => {
  const result = await fetchWarmPolicy({
    origin: 'https://store.example',
    proxyPath: '/apps/clawpilot/checkout-rate-warmer',
    cartFingerprint: FINGERPRINT,
    cartCurrency: 'USD',
    fetchImpl: async () => ({
      ok: false,
      status: 403,
    }),
    signal: new AbortController().signal,
  })
  assert.equal(result, null)
})

test('shipping-rate polling tolerates late completion inside the 12 second window', async () => {
  let asyncReads = 0
  const methods = []
  const rates = await warmShippingZone({
    zone: { countryCode: 'US', provinceCode: 'CT', postalCode: '06611' },
    routesRoot: '/en/',
    guard: async () => {},
    signal: new AbortController().signal,
    sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      methods.push(init.method)
      if (init.method === 'POST') {
        return { ok: true, status: 200 }
      }
      asyncReads += 1
      return {
        ok: true,
        status: 200,
        json: async () => ({
          shipping_rates: asyncReads === 31
            ? [{ name: 'AG Alchemy UPS Ground' }]
            : null,
        }),
      }
    },
  })

  assert.equal(asyncReads, 31)
  assert.deepEqual(methods, ['POST', ...Array(31).fill('GET')])
  assert.deepEqual(rates, [{ name: 'AG Alchemy UPS Ground' }])
})

test('shipping-rate polling has a deterministic bounded timeout', async () => {
  let asyncReads = 0
  await assert.rejects(
    warmShippingZone({
      zone: { countryCode: 'US', provinceCode: 'CT', postalCode: '06611' },
      routesRoot: '/',
      guard: async () => {},
      signal: new AbortController().signal,
      pollAttempts: 3,
      sleepImpl: async () => {},
      fetchImpl: async (_url, init) => {
        if (init.method === 'POST') return { ok: true, status: 200 }
        asyncReads += 1
        return {
          ok: true,
          status: 200,
          json: async () => ({ shipping_rates: null }),
        }
      },
    }),
    /timed out/,
  )
  assert.equal(asyncReads, 3)
})

test('aborting the shared controller stops an in-flight Ajax request', async () => {
  const controller = new AbortController()
  let receivedSignal = null
  let requestStarted
  const started = new Promise((resolve) => {
    requestStarted = resolve
  })
  const pending = warmShippingZone({
    zone: { countryCode: 'US', provinceCode: 'CT', postalCode: '06611' },
    routesRoot: '/',
    guard: async () => {},
    signal: controller.signal,
    fetchImpl: async (_url, init) => {
      receivedSignal = init.signal
      requestStarted()
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(init.signal.reason)
        }, { once: true })
      })
    },
  })
  await started
  const reason = new CartChangedError()
  controller.abort(reason)

  await assert.rejects(pending, (error) => error === reason)
  assert.equal(receivedSignal, controller.signal)
})
