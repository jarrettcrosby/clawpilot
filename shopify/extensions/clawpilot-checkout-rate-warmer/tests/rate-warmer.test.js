import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CartChangedError,
  RATE_WARM_STATUS_EVENT,
  cartUrl,
  createDebouncer,
  dedupeDestinations,
  dispatchRateWarmStatus,
  fetchWarmPolicy,
  normalizePolicy,
  processDestinations,
  proxyPolicyUrl,
  shippingRateUrl,
  warmAllDestinations,
  warmShippingDestination,
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
    destinations: [
      {
        address1: '35 Saxony Drive',
        address2: '',
        city: 'Trumbull',
        province: 'CT',
        country: 'US',
        zip: '06611',
      },
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

test('cart fingerprint change aborts before another destination begins', async () => {
  const controller = new AbortController()
  let fingerprintReads = 0
  const started = []
  const twoDestinations = policy({
    concurrency: 1,
    destinations: [
      {
        address1: '35 Saxony Drive',
        address2: '',
        city: 'Trumbull',
        province: 'CT',
        country: 'US',
        zip: '06611',
      },
      {
        address1: '16691 Gothard Street',
        address2: 'Suite Q',
        city: 'Huntington Beach',
        province: 'CA',
        country: 'US',
        zip: '92647',
      },
    ],
  })

  await assert.rejects(
    warmAllDestinations({
      policy: twoDestinations,
      expectedFingerprint: FINGERPRINT,
      controller,
      readFingerprint: async () => {
        fingerprintReads += 1
        return fingerprintReads === 1 ? FINGERPRINT : 'b'.repeat(64)
      },
      warmDestination: async ({ destination, guard }) => {
        started.push(destination.zip)
        await guard()
        await guard()
      },
    }),
    (error) => error instanceof CartChangedError,
  )

  assert.equal(controller.signal.aborted, true)
  assert.deepEqual(started, ['06611'])
})

test('all full destinations run and an ordinary address error is isolated', async () => {
  const seen = []
  const destinations = [
    {
      address1: '35 Saxony Drive',
      address2: '',
      city: 'Trumbull',
      province: 'CT',
      country: 'US',
      zip: '06611',
    },
    {
      address1: '35  SAXONY drive',
      address2: '',
      city: 'TRUMBULL',
      province: 'CT',
      country: 'US',
      zip: '06611',
    },
    {
      address1: '16691 Gothard Street',
      address2: 'Suite Q',
      city: 'Huntington Beach',
      province: 'CA',
      country: 'US',
      zip: '92647',
    },
    {
      address1: '100 King Street West',
      address2: '',
      city: 'Toronto',
      province: 'ON',
      country: 'CA',
      zip: 'M5V 2T6',
    },
  ]

  const results = await processDestinations(
    destinations,
    2,
    async (destination) => {
      seen.push(`${destination.country}:${destination.zip}`)
      if (destination.zip === '92647') {
        throw new Error('destination unavailable')
      }
      return destination.zip
    },
  )

  assert.deepEqual(seen.sort(), [
    'CA:M5V 2T6',
    'US:06611',
    'US:92647',
  ])
  assert.equal(results.length, 3)
  assert.equal(results.filter((result) => result.ok).length, 2)
  assert.equal(results.filter((result) => !result.ok).length, 1)
})

test('full destination identity retains different streets in one ZIP', () => {
  const values = [
    {
      address1: '100 Main Street',
      address2: '',
      city: 'Beverly Hills',
      province: 'CA',
      country: 'US',
      zip: '90210',
    },
    {
      address1: '200 Main Street',
      address2: '',
      city: 'Beverly Hills',
      province: 'CA',
      country: 'US',
      zip: '90210',
    },
    {
      address1: '100  MAIN street',
      address2: '',
      city: 'BEVERLY HILLS',
      province: 'CA',
      country: 'US',
      zip: '90210',
    },
  ]

  assert.deepEqual(dedupeDestinations(values), values.slice(0, 2))
})

test('bounded workers process every returned destination without slicing', async () => {
  const destinations = Array.from({ length: 250 }, (_, index) => ({
    address1: `${index + 1} Test Street`,
    address2: '',
    city: 'Trumbull',
    province: 'CT',
    country: 'US',
    zip: '06611',
  }))
  const seen = new Set()
  let active = 0
  let maximumActive = 0
  const results = await processDestinations(
    destinations,
    4,
    async (destination) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      seen.add(destination.address1)
      await Promise.resolve()
      active -= 1
    },
  )

  assert.equal(results.length, 250)
  assert.equal(seen.size, 250)
  assert.equal(maximumActive, 4)
})

test('locale-aware cart and shipping-rate URLs use the full Shopify address', () => {
  assert.equal(cartUrl('/fr-ca/'), '/fr-ca/cart.js')
  const prepare = new URL(
    shippingRateUrl('/fr-ca/', 'prepare', {
      address1: '500 Rue Saint-Jacques',
      address2: 'Bureau 200',
      city: 'Montréal',
      province: 'QC',
      country: 'CA',
      zip: 'H2Y 1S1',
    }),
    'https://store.example',
  )
  assert.equal(prepare.pathname, '/fr-ca/cart/prepare_shipping_rates.json')
  assert.equal(
    prepare.searchParams.get('shipping_address[address1]'),
    '500 Rue Saint-Jacques',
  )
  assert.equal(
    prepare.searchParams.get('shipping_address[address2]'),
    'Bureau 200',
  )
  assert.equal(prepare.searchParams.get('shipping_address[city]'), 'Montréal')
  assert.equal(prepare.searchParams.get('shipping_address[country]'), 'CA')
  assert.equal(prepare.searchParams.get('shipping_address[province]'), 'QC')
  assert.equal(prepare.searchParams.get('shipping_address[zip]'), 'H2Y 1S1')

  const asynchronous = new URL(
    shippingRateUrl('/', 'async', {
      address1: '35 Saxony Drive',
      address2: '',
      city: 'Trumbull',
      province: '',
      country: 'US',
      zip: '06611',
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
  assert.equal(normalized?.destinations.length, 1)
  assert.deepEqual(normalized?.coverage, {
    scanned: 4,
    eligible: 3,
    duplicate: 1,
    invalid: 0,
    unsupported: 0,
  })
})

test('aggregate status event exposes counts without destinations or private facts', () => {
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
      destination: {
        address1: '35 Saxony Drive',
        address2: '',
        city: 'Trumbull',
        province: 'CT',
        country: 'US',
        zip: '06611',
      },
      value: [{ name: 'Private carrier fact' }],
    },
    {
      ok: false,
      destination: {
        address1: '100 Private Street',
        address2: '',
        city: 'Beverly Hills',
        province: 'CA',
        country: 'US',
        zip: '90210',
      },
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
    destinations: { attempted: 2, succeeded: 1, failed: 1 },
    runs: { completed: 1, failed: 0, aborted: 0 },
  })
  const serialized = JSON.stringify(events[0].detail)
  assert.equal(serialized.includes('06611'), false)
  assert.equal(serialized.includes('90210'), false)
  assert.equal(serialized.includes('Saxony'), false)
  assert.equal(serialized.includes('Beverly'), false)
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
  const rates = await warmShippingDestination({
    destination: policy().destinations[0],
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
    warmShippingDestination({
      destination: policy().destinations[0],
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
  const pending = warmShippingDestination({
    destination: policy().destinations[0],
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
