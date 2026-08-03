const CART_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/
const PROVINCE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,15}$/
const CURRENCY_PATTERN = /^[A-Z]{3}$/
const MAX_POSTAL_CODE_LENGTH = 32
const MAX_ADDRESS_LINE_LENGTH = 255
const MAX_CITY_LENGTH = 255
const DEFAULT_DEBOUNCE_MS = 350
const DEFAULT_POLL_INTERVAL_MS = 300
const DEFAULT_POLL_ATTEMPTS = 40
const FALLBACK_OBSERVATION_MS = 10_000
export const RATE_WARM_STATUS_EVENT = 'clawpilot:checkout-rate-warm-status'

export class CartChangedError extends Error {
  constructor() {
    super('The Shopify cart changed while rates were warming')
    this.name = 'CartChangedError'
    this.code = 'CART_CHANGED'
  }
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : null
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  const object = record(value)
  if (!object) return value
  return Object.keys(object)
    .sort()
    .reduce((result, key) => {
      result[key] = stableValue(object[key])
      return result
    }, {})
}

function cartFingerprintInput(cart) {
  const value = record(cart) || {}
  const items = Array.isArray(value.items) ? value.items : []
  return JSON.stringify({
    currency: typeof value.currency === 'string'
      ? value.currency.toUpperCase()
      : '',
    items: items
      .map((item) => {
        const line = record(item) || {}
        const sellingPlan = record(
          record(line.selling_plan_allocation)?.selling_plan,
        )
        return {
          finalLinePrice: line.final_line_price ?? null,
          grams: line.grams ?? null,
          id: line.id ?? null,
          key: line.key ?? null,
          properties: stableValue(record(line.properties) || {}),
          quantity: line.quantity ?? null,
          requiresShipping: line.requires_shipping ?? null,
          sellingPlanId: sellingPlan?.id ?? null,
          variantId: line.variant_id ?? null,
        }
      })
      .sort((left, right) => {
        const leftValue = JSON.stringify(left)
        const rightValue = JSON.stringify(right)
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
      }),
    token: typeof value.token === 'string' ? value.token : '',
  })
}

async function browserDigestHex(value) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder !== 'function') {
    throw new Error('Secure cart fingerprinting is unavailable')
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return Array.from(new Uint8Array(digest), (byte) => (
    byte.toString(16).padStart(2, '0')
  )).join('')
}

export async function fingerprintCart(cart, digestHex = browserDigestHex) {
  const fingerprint = await digestHex(cartFingerprintInput(cart))
  if (!CART_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new Error('Cart fingerprinting returned an invalid digest')
  }
  return fingerprint
}

export function normalizeRoutesRoot(routesRoot) {
  if (
    typeof routesRoot !== 'string'
    || !routesRoot.startsWith('/')
    || routesRoot.startsWith('//')
  ) {
    throw new Error('Shopify routes root must be a same-origin path')
  }
  const parsed = new URL(routesRoot, 'https://shopify.invalid')
  if (
    parsed.origin !== 'https://shopify.invalid'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('Shopify routes root must be a same-origin path')
  }
  return `${parsed.pathname.replace(/\/+$/, '')}/`
}

export function cartUrl(routesRoot) {
  return `${normalizeRoutesRoot(routesRoot)}cart.js`
}

function storedCountryCode(value) {
  const result = typeof value === 'string' ? value : ''
  return COUNTRY_CODE_PATTERN.test(result) ? result : null
}

function storedProvinceCode(value) {
  if (value === null || value === undefined || value === '') return null
  const result = typeof value === 'string' ? value : ''
  return PROVINCE_CODE_PATTERN.test(result) ? result : undefined
}

function storedPostalCode(value) {
  if (typeof value !== 'string') return null
  return (
    value.trim().length >= 1
    && value.length <= MAX_POSTAL_CODE_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value)
  ) ? value : null
}

function storedRequiredText(value, maximumLength) {
  if (typeof value !== 'string') return null
  return (
    value.trim().length >= 1
    && value.length <= maximumLength
    && !/[\u0000-\u001f\u007f]/.test(value)
  ) ? value : null
}

function storedOptionalText(value, maximumLength) {
  if (value === null || value === undefined || value === '') return ''
  return storedRequiredText(value, maximumLength)
}

function canonicalDestinationPart(value) {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleUpperCase('en-US')
}

export function normalizeDestination(value) {
  const candidate = record(value)
  if (!candidate) return null
  const address1 = storedRequiredText(
    candidate.address1,
    MAX_ADDRESS_LINE_LENGTH,
  )
  const address2 = storedOptionalText(
    candidate.address2,
    MAX_ADDRESS_LINE_LENGTH,
  )
  const city = storedRequiredText(candidate.city, MAX_CITY_LENGTH)
  const province = storedProvinceCode(candidate.province)
  const country = storedCountryCode(candidate.country)
  const zip = storedPostalCode(candidate.zip)
  if (
    !address1
    || address2 === null
    || !city
    || province === undefined
    || !country
    || !zip
  ) return null
  return {
    address1,
    address2,
    city,
    province: province || '',
    country,
    zip,
  }
}

function destinationKey(destination) {
  return [
    destination.address1,
    destination.address2,
    destination.city,
    destination.province,
    destination.country,
    destination.zip,
  ]
    .map(canonicalDestinationPart)
    .join('|')
}

export function dedupeDestinations(values) {
  if (!Array.isArray(values)) return []
  const destinationsByKey = new Map()
  for (const value of values) {
    const destination = normalizeDestination(value)
    if (!destination) return []
    const key = destinationKey(destination)
    if (!destinationsByKey.has(key)) {
      destinationsByKey.set(key, destination)
    }
  }
  return [...destinationsByKey.values()]
}

export function shippingRateUrl(routesRoot, operation, value) {
  const destination = normalizeDestination(value)
  if (!destination) throw new Error('Shipping rate destination is invalid')
  const filename = operation === 'prepare'
    ? 'prepare_shipping_rates.json'
    : operation === 'async'
      ? 'async_shipping_rates.json'
      : null
  if (!filename) throw new Error('Shipping rate operation is invalid')
  const query = new URLSearchParams()
  query.set('shipping_address[address1]', destination.address1)
  query.set('shipping_address[address2]', destination.address2)
  query.set('shipping_address[city]', destination.city)
  if (destination.province) {
    query.set('shipping_address[province]', destination.province)
  }
  query.set('shipping_address[country]', destination.country)
  query.set('shipping_address[zip]', destination.zip)
  return `${normalizeRoutesRoot(routesRoot)}cart/${filename}?${query}`
}

export function proxyPolicyUrl(
  origin,
  proxyPath,
  cartFingerprint,
  cartCurrency,
) {
  if (!CART_FINGERPRINT_PATTERN.test(cartFingerprint)) {
    throw new Error('Cart fingerprint is invalid')
  }
  if (
    typeof proxyPath !== 'string'
    || !proxyPath.startsWith('/apps/')
    || proxyPath.startsWith('//')
    || proxyPath.includes('?')
    || proxyPath.includes('#')
    || proxyPath.includes('\\')
    || proxyPath.split('/').includes('..')
  ) {
    throw new Error('App proxy must use a same-origin /apps path')
  }
  const base = new URL(origin)
  if (!['http:', 'https:'].includes(base.protocol)) {
    throw new Error('Storefront origin is invalid')
  }
  const url = new URL(proxyPath, base)
  if (url.origin !== base.origin || !url.pathname.startsWith('/apps/')) {
    throw new Error('App proxy must be same-origin')
  }
  url.searchParams.set('cart_fingerprint', cartFingerprint)
  if (cartCurrency !== null && cartCurrency !== undefined) {
    const currency = String(cartCurrency).trim().toUpperCase()
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new Error('Cart currency is invalid')
    }
    url.searchParams.set('cart_currency', currency)
  }
  return `${url.pathname}${url.search}`
}

export function normalizePolicy(value, expectedFingerprint) {
  const candidate = record(value)
  if (
    !candidate
    || candidate.version !== 1
    || candidate.enabled !== true
    || candidate.mode !== 'hosted_ajax'
    || candidate.cartFingerprint !== expectedFingerprint
    || !CART_FINGERPRINT_PATTERN.test(candidate.cartFingerprint)
    || candidate.staleCartAbort !== true
  ) return null

  const policyRevision = boundedInteger(candidate.policyRevision, 0, 2 ** 31 - 1)
  const concurrency = boundedInteger(candidate.concurrency, 1, 8)
  const debounceMs = boundedInteger(candidate.debounceMs, 0, 5_000)
  const minIntervalMs = boundedInteger(candidate.minIntervalMs, 250, 60_000)
  const destinations = dedupeDestinations(candidate.destinations)
  const coverageCandidate = record(candidate.coverage)
  const coverage = coverageCandidate && {
    scanned: boundedInteger(coverageCandidate.scanned, 0, 250),
    eligible: boundedInteger(coverageCandidate.eligible, 0, 250),
    duplicate: boundedInteger(coverageCandidate.duplicate, 0, 250),
    invalid: boundedInteger(coverageCandidate.invalid, 0, 250),
    unsupported: boundedInteger(coverageCandidate.unsupported, 0, 250),
  }
  if (
    policyRevision === null
    || concurrency === null
    || debounceMs === null
    || minIntervalMs === null
    || !Array.isArray(candidate.destinations)
    || destinations.length < 1
    || !coverage
    || Object.values(coverage).some((count) => count === null)
  ) return null
  return {
    version: 1,
    enabled: true,
    mode: 'hosted_ajax',
    policyRevision,
    cartFingerprint: candidate.cartFingerprint,
    concurrency,
    debounceMs,
    minIntervalMs,
    staleCartAbort: true,
    destinations,
    coverage,
  }
}

export function dispatchRateWarmStatus(
  windowObject,
  { status, coverage, results = [] },
) {
  const CustomEventConstructor = windowObject?.CustomEvent
    || globalThis.CustomEvent
  const coverageCandidate = record(coverage)
  const normalizedCoverage = coverageCandidate && {
    scanned: boundedInteger(coverageCandidate.scanned, 0, 250),
    eligible: boundedInteger(coverageCandidate.eligible, 0, 250),
    duplicate: boundedInteger(coverageCandidate.duplicate, 0, 250),
    invalid: boundedInteger(coverageCandidate.invalid, 0, 250),
    unsupported: boundedInteger(coverageCandidate.unsupported, 0, 250),
  }
  if (
    typeof windowObject?.dispatchEvent !== 'function'
    || typeof CustomEventConstructor !== 'function'
    || !['completed', 'failed', 'aborted'].includes(status)
    || !normalizedCoverage
    || Object.values(normalizedCoverage).some((count) => count === null)
    || !Array.isArray(results)
  ) return false

  const succeeded = results.filter((result) => result?.ok === true).length
  const failed = results.filter((result) => result?.ok === false).length
  const detail = {
    version: 1,
    status,
    coverage: normalizedCoverage,
    destinations: {
      attempted: results.length,
      succeeded,
      failed,
    },
    runs: {
      completed: status === 'completed' ? 1 : 0,
      failed: status === 'failed' ? 1 : 0,
      aborted: status === 'aborted' ? 1 : 0,
    },
  }
  try {
    windowObject.dispatchEvent(new CustomEventConstructor(
      RATE_WARM_STATUS_EVENT,
      { detail },
    ))
    return true
  } catch {
    return false
  }
}

export function createDebouncer({
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null
  return {
    schedule(callback, delayMs) {
      if (timer !== null) clearTimer(timer)
      timer = setTimer(() => {
        timer = null
        callback()
      }, delayMs)
    },
    cancel() {
      if (timer !== null) clearTimer(timer)
      timer = null
    },
  }
}

function isFatalError(error) {
  return error instanceof CartChangedError
    || error?.name === 'AbortError'
    || error?.code === 'CART_CHANGED'
}

export async function processDestinations(values, concurrency, task) {
  const destinations = dedupeDestinations(values)
  const workerCount = Math.min(
    boundedInteger(concurrency, 1, 8) || 1,
    destinations.length,
  )
  const results = []
  let index = 0
  let fatalError = null

  async function worker() {
    while (index < destinations.length && !fatalError) {
      const destination = destinations[index]
      index += 1
      try {
        const value = await task(destination)
        results.push({ destination, ok: true, value })
      } catch (error) {
        if (isFatalError(error)) {
          fatalError = error
          throw error
        }
        results.push({ destination, ok: false, error })
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

export function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason || new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function responseJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export async function warmShippingDestination({
  destination,
  routesRoot,
  fetchImpl,
  guard,
  signal,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  pollAttempts = DEFAULT_POLL_ATTEMPTS,
  sleepImpl = sleep,
}) {
  await guard()
  const prepared = await fetchImpl(
    shippingRateUrl(routesRoot, 'prepare', destination),
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal,
    },
  )
  if (!prepared.ok) {
    throw new Error(`Shipping rate preparation failed (${prepared.status})`)
  }

  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    await sleepImpl(pollIntervalMs, signal)
    await guard()
    const response = await fetchImpl(
      shippingRateUrl(routesRoot, 'async', destination),
      {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal,
      },
    )
    if (response.status === 202) continue
    if (!response.ok) {
      throw new Error(`Shipping rate polling failed (${response.status})`)
    }
    const payload = await responseJson(response)
    if (payload === null || payload?.shipping_rates === null) continue
    if (Array.isArray(payload?.shipping_rates)) {
      return payload.shipping_rates
    }
    throw new Error('Shipping rate polling returned an invalid response')
  }
  throw new Error('Shipping rate polling timed out')
}

export async function warmAllDestinations({
  policy,
  expectedFingerprint,
  controller,
  readFingerprint,
  warmDestination,
}) {
  const guard = async () => {
    if (controller.signal.aborted) {
      throw controller.signal.reason || new CartChangedError()
    }
    const currentFingerprint = await readFingerprint(controller.signal)
    if (currentFingerprint !== expectedFingerprint) {
      const error = new CartChangedError()
      controller.abort(error)
      throw error
    }
  }
  return processDestinations(
    policy.destinations,
    policy.concurrency,
    (destination) => (
      warmDestination({ destination, guard, signal: controller.signal })
    ),
  )
}

export async function readCart({
  routesRoot,
  fetchImpl,
  signal,
}) {
  const response = await fetchImpl(cartUrl(routesRoot), {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal,
  })
  if (!response.ok) {
    throw new Error(`Shopify cart read failed (${response.status})`)
  }
  const cart = await responseJson(response)
  if (!record(cart) || !Array.isArray(cart.items)) {
    throw new Error('Shopify cart response was invalid')
  }
  return cart
}

export async function fetchWarmPolicy({
  origin,
  proxyPath,
  cartFingerprint,
  cartCurrency,
  fetchImpl,
  signal,
}) {
  let response
  try {
    response = await fetchImpl(
      proxyPolicyUrl(
        origin,
        proxyPath,
        cartFingerprint,
        cartCurrency,
      ),
      {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal,
      },
    )
  } catch (error) {
    if (signal?.aborted) throw error
    return null
  }
  if (!response.ok) return null
  return normalizePolicy(await responseJson(response), cartFingerprint)
}

export async function settleCartEvent(event) {
  const pending = event?.detail?.promise || event?.promise
  if (pending && typeof pending.then === 'function') {
    try {
      await pending
    } catch {
      // The fallback cart read determines whether there is work to perform.
    }
  }
}

export function createCheckoutRateWarmer({
  documentObject = globalThis.document,
  windowObject = globalThis.window,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  setIntervalImpl = globalThis.setInterval?.bind(globalThis),
  clearIntervalImpl = globalThis.clearInterval?.bind(globalThis),
  now = Date.now,
} = {}) {
  const marker = documentObject?.querySelector?.(
    '[data-clawpilot-checkout-rate-warmer]',
  )
  if (
    !marker
    || !windowObject
    || !fetchImpl
    || windowObject.Shopify?.designMode
  ) return null

  const routesRoot = normalizeRoutesRoot(
    windowObject.Shopify?.routes?.root || '/',
  )
  const proxyPath = marker.dataset?.appProxyPath
  proxyPolicyUrl(
    windowObject.location.origin,
    proxyPath,
    '0'.repeat(64),
    null,
  )

  const debouncer = createDebouncer()
  const lastWarmAt = new Map()
  let debounceMs = DEFAULT_DEBOUNCE_MS
  let observedFingerprint = null
  let activeController = null
  let fallbackTimer = null
  let stopped = false
  let observing = false

  const readCurrent = async (signal) => {
    const cart = await readCart({ routesRoot, fetchImpl, signal })
    return {
      cart,
      fingerprint: await fingerprintCart(cart),
    }
  }

  const abortActive = () => {
    if (activeController && !activeController.signal.aborted) {
      activeController.abort(new CartChangedError())
    }
    activeController = null
  }

  const run = async () => {
    if (stopped) return
    abortActive()
    const controller = new AbortController()
    activeController = controller
    let coverage = null
    try {
      const current = await readCurrent(controller.signal)
      observedFingerprint = current.fingerprint
      if (!Array.isArray(current.cart.items) || current.cart.items.length < 1) {
        return
      }
      const currency = typeof current.cart.currency === 'string'
        ? current.cart.currency.toUpperCase()
        : null
      const policy = await fetchWarmPolicy({
        origin: windowObject.location.origin,
        proxyPath,
        cartFingerprint: current.fingerprint,
        cartCurrency: currency,
        fetchImpl,
        signal: controller.signal,
      })
      if (!policy) return
      coverage = policy.coverage
      debounceMs = policy.debounceMs
      const lastRun = lastWarmAt.get(current.fingerprint) || 0
      if (now() - lastRun < policy.minIntervalMs) return
      const results = await warmAllDestinations({
        policy,
        expectedFingerprint: current.fingerprint,
        controller,
        readFingerprint: async (signal) => (
          (await readCurrent(signal)).fingerprint
        ),
        warmDestination: ({
          destination,
          guard,
          signal,
        }) => warmShippingDestination({
          destination,
          routesRoot,
          fetchImpl,
          guard,
          signal,
        }),
      })
      dispatchRateWarmStatus(windowObject, {
        status: 'completed',
        coverage,
        results,
      })
      lastWarmAt.set(current.fingerprint, now())
    } catch (error) {
      if (coverage) {
        dispatchRateWarmStatus(windowObject, {
          status: isFatalError(error) ? 'aborted' : 'failed',
          coverage,
        })
      }
      if (!isFatalError(error)) {
        // This optimization is fail-closed and must never block storefront use.
      }
    } finally {
      if (activeController === controller) activeController = null
    }
  }

  const schedule = () => {
    if (!stopped) debouncer.schedule(() => void run(), debounceMs)
  }

  const observe = async () => {
    if (stopped || observing) return
    observing = true
    try {
      const current = await readCurrent()
      if (current.fingerprint !== observedFingerprint) {
        abortActive()
        observedFingerprint = current.fingerprint
        schedule()
      }
    } catch {
      // A later event or observation can retry without affecting the cart.
    } finally {
      observing = false
    }
  }

  const onCartLinesUpdate = async (event) => {
    abortActive()
    debouncer.cancel()
    await settleCartEvent(event)
    if (!stopped) await observe()
  }
  const onPageShow = () => void observe()
  const onFocus = () => void observe()
  const onVisibility = () => {
    if (documentObject.visibilityState === 'visible') void observe()
  }

  documentObject.addEventListener(
    'shopify:cart:lines-update',
    onCartLinesUpdate,
  )
  windowObject.addEventListener('pageshow', onPageShow)
  windowObject.addEventListener('focus', onFocus)
  documentObject.addEventListener('visibilitychange', onVisibility)
  fallbackTimer = setIntervalImpl?.(
    () => void observe(),
    FALLBACK_OBSERVATION_MS,
  )
  void observe()

  return {
    stop() {
      stopped = true
      abortActive()
      debouncer.cancel()
      if (fallbackTimer !== null) clearIntervalImpl?.(fallbackTimer)
      documentObject.removeEventListener(
        'shopify:cart:lines-update',
        onCartLinesUpdate,
      )
      windowObject.removeEventListener('pageshow', onPageShow)
      windowObject.removeEventListener('focus', onFocus)
      documentObject.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
