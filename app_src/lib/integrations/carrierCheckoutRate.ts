export type CheckoutRateCarrierProvider = 'ups_rest' | 'fedex_rest'

export type CheckoutRateParcel = {
  packageKey: string
  description: string
  exteriorInches: {
    length: number
    width: number
    height: number
  }
  grossPounds: number
}

export type CheckoutRateDestination = {
  name: string
  line1: string
  line2: string | null
  city: string
  region: string
  postalCode: string
  countryCode: 'US'
}

export type CheckoutRateCarrierSelection = {
  provider: CheckoutRateCarrierProvider
  carrierAccountGlobalId: string
}

export type CheckoutRateProviderQuote = {
  serviceCode: string
  serviceName: string
  amount: string
  currency: string
  transitDays: number | null
  deliveryDate: string | null
  evidenceGlobalId: string
}

export type CheckoutRateProviderResult = {
  provider: CheckoutRateCarrierProvider
  carrierAccountGlobalId: string
  packageCount: number
  rateScope: 'multi_package_shipment'
  rates: CheckoutRateProviderQuote[]
}

export type CheckoutRateOffer = {
  provider: CheckoutRateCarrierProvider
  carrierAccountGlobalId: string
  carrierCode: 'ups' | 'fedex'
  serviceLevelCode: string
  serviceName: string
  amountMinor: number
  currency: string
  transitDays: number | null
  deliveryDate: string | null
  evidenceGlobalId: string
}

export type CheckoutShipmentRateResult = {
  rateScope: 'multi_package_shipment'
  packageCount: number
  requiredProviders: CheckoutRateCarrierProvider[]
  offers: CheckoutRateOffer[]
  completedAt: string
}

export class CheckoutShipmentRateError extends Error {
  readonly code: string
  readonly provider: CheckoutRateCarrierProvider | null

  constructor(
    code: string,
    message: string,
    provider: CheckoutRateCarrierProvider | null = null,
  ) {
    super(message)
    this.name = 'CheckoutShipmentRateError'
    this.code = code
    this.provider = provider
  }
}

const ACCOUNT_GLOBAL_ID = /^gac[0-9]{7}$/
const PACKAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const SERVICE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/
const EVIDENCE_GLOBAL_ID = /^[a-z]{2,4}[0-9]{7}$/
const CURRENCY = /^[A-Z]{3}$/
const DECIMAL_MONEY = /^(?:0|[1-9][0-9]{0,12})(?:\.[0-9]{1,2})?$/

function rateError(
  code: string,
  message: string,
  provider: CheckoutRateCarrierProvider | null = null,
): never {
  throw new CheckoutShipmentRateError(code, message, provider)
}

function positiveFinite(value: unknown, label: string) {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value <= 0
    || value > 1_000_000
  ) {
    rateError('CHECKOUT_RATE_PACKAGE_INVALID', `${label} must be positive`)
  }
  return value
}

function normalizeParcels(value: CheckoutRateParcel[]) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    rateError(
      'CHECKOUT_RATE_PACKAGE_COUNT_INVALID',
      'Checkout rating requires between 1 and 50 complete packages',
    )
  }
  const seen = new Set<string>()
  return value.map((parcel) => {
    if (
      !parcel
      || typeof parcel !== 'object'
      || !PACKAGE_KEY.test(parcel.packageKey)
      || seen.has(parcel.packageKey)
      || typeof parcel.description !== 'string'
      || !parcel.description.trim()
      || parcel.description.length > 255
    ) {
      rateError(
        'CHECKOUT_RATE_PACKAGE_INVALID',
        'Every checkout package requires a unique key and description',
      )
    }
    seen.add(parcel.packageKey)
    return {
      packageKey: parcel.packageKey,
      description: parcel.description.trim(),
      exteriorInches: {
        length: positiveFinite(
          parcel.exteriorInches?.length,
          'Package length',
        ),
        width: positiveFinite(
          parcel.exteriorInches?.width,
          'Package width',
        ),
        height: positiveFinite(
          parcel.exteriorInches?.height,
          'Package height',
        ),
      },
      grossPounds: positiveFinite(parcel.grossPounds, 'Package weight'),
    }
  })
}

function normalizeCarriers(value: CheckoutRateCarrierSelection[]) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    rateError(
      'CHECKOUT_RATE_CARRIERS_INVALID',
      'Checkout rating requires one or two configured carriers',
    )
  }
  const seen = new Set<CheckoutRateCarrierProvider>()
  return value.map((selection) => {
    if (
      !selection
      || (
        selection.provider !== 'ups_rest'
        && selection.provider !== 'fedex_rest'
      )
      || seen.has(selection.provider)
      || !ACCOUNT_GLOBAL_ID.test(selection.carrierAccountGlobalId)
    ) {
      rateError(
        'CHECKOUT_RATE_CARRIERS_INVALID',
        'Checkout carriers must be unique configured UPS or FedEx accounts',
      )
    }
    seen.add(selection.provider)
    return { ...selection }
  })
}

function amountMinor(value: unknown, provider: CheckoutRateCarrierProvider) {
  if (typeof value !== 'string' || !DECIMAL_MONEY.test(value)) {
    rateError(
      'CHECKOUT_RATE_AMOUNT_INVALID',
      'Carrier rate amount must be an exact nonnegative decimal',
      provider,
    )
  }
  const [whole, fraction = ''] = value.split('.')
  const minor = Number(`${whole}${fraction.padEnd(2, '0')}`)
  if (!Number.isSafeInteger(minor) || minor < 0) {
    rateError(
      'CHECKOUT_RATE_AMOUNT_INVALID',
      'Carrier rate amount exceeds the supported range',
      provider,
    )
  }
  return minor
}

function normalizeProviderResult(
  result: CheckoutRateProviderResult,
  expected: CheckoutRateCarrierSelection,
  packageCount: number,
  currency: string,
): CheckoutRateOffer[] {
  if (
    !result
    || result.provider !== expected.provider
    || result.carrierAccountGlobalId !== expected.carrierAccountGlobalId
    || result.rateScope !== 'multi_package_shipment'
    || result.packageCount !== packageCount
    || !Array.isArray(result.rates)
    || result.rates.length < 1
    || result.rates.length > 50
  ) {
    rateError(
      'CHECKOUT_RATE_PROVIDER_RESPONSE_INVALID',
      'Carrier returned an invalid whole-shipment rate response',
      expected.provider,
    )
  }
  const seen = new Set<string>()
  return result.rates.map((rate) => {
    const normalizedCurrency = String(rate.currency || '').toUpperCase()
    if (
      !SERVICE_CODE.test(rate.serviceCode)
      || seen.has(rate.serviceCode)
      || typeof rate.serviceName !== 'string'
      || !rate.serviceName.trim()
      || rate.serviceName.length > 255
      || normalizedCurrency !== currency
      || !CURRENCY.test(normalizedCurrency)
      || !EVIDENCE_GLOBAL_ID.test(rate.evidenceGlobalId)
      || (
        rate.transitDays !== null
        && (
          !Number.isInteger(rate.transitDays)
          || rate.transitDays < 0
          || rate.transitDays > 365
        )
      )
      || (
        rate.deliveryDate !== null
        && (
          typeof rate.deliveryDate !== 'string'
          || !/^\d{4}-\d{2}-\d{2}$/.test(rate.deliveryDate)
        )
      )
    ) {
      rateError(
        'CHECKOUT_RATE_PROVIDER_RESPONSE_INVALID',
        'Carrier returned invalid or duplicate service evidence',
        expected.provider,
      )
    }
    seen.add(rate.serviceCode)
    return {
      provider: expected.provider,
      carrierAccountGlobalId: expected.carrierAccountGlobalId,
      carrierCode: expected.provider === 'ups_rest' ? 'ups' : 'fedex',
      serviceLevelCode: rate.serviceCode.toLowerCase(),
      serviceName: rate.serviceName.trim(),
      amountMinor: amountMinor(rate.amount, expected.provider),
      currency: normalizedCurrency,
      transitDays: rate.transitDays,
      deliveryDate: rate.deliveryDate,
      evidenceGlobalId: rate.evidenceGlobalId,
    }
  })
}

/**
 * Calls every required carrier exactly once with the complete package array.
 * A partial carrier result is never returned to Shopify because a missing
 * required carrier would make checkout behavior depend on a transient failure.
 */
export async function rateCheckoutShipment(input: {
  destination: CheckoutRateDestination
  parcels: CheckoutRateParcel[]
  carriers: CheckoutRateCarrierSelection[]
  currency: string
  deadlineAt: number
  signal?: AbortSignal
  invoke: (
    selection: CheckoutRateCarrierSelection,
    request: {
      destination: CheckoutRateDestination
      parcels: CheckoutRateParcel[]
      signal: AbortSignal
    },
  ) => Promise<CheckoutRateProviderResult>
  now?: () => number
}): Promise<CheckoutShipmentRateResult> {
  const now = input.now ?? Date.now
  const startedAt = now()
  if (
    !Number.isSafeInteger(input.deadlineAt)
    || input.deadlineAt <= startedAt
    || input.deadlineAt - startedAt > 30_000
  ) {
    rateError(
      'CHECKOUT_RATE_DEADLINE_INVALID',
      'Checkout rating requires a future deadline no more than 30 seconds away',
    )
  }
  if (!CURRENCY.test(input.currency)) {
    rateError(
      'CHECKOUT_RATE_CURRENCY_INVALID',
      'Checkout currency must be an uppercase ISO code',
    )
  }
  if (typeof input.invoke !== 'function') {
    rateError(
      'CHECKOUT_RATE_ADAPTER_INVALID',
      'Checkout rating requires a carrier adapter',
    )
  }
  if (input.signal?.aborted) {
    rateError(
      'CHECKOUT_RATE_DEADLINE_EXCEEDED',
      'Required carrier rating exceeded the checkout deadline',
    )
  }

  const parcels = normalizeParcels(input.parcels)
  const carriers = normalizeCarriers(input.carriers)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  let abortFromCaller: (() => void) | null = null

  const timeout = new Promise<never>((_resolve, reject) => {
    const rejectForDeadline = () => {
      controller.abort()
      reject(new CheckoutShipmentRateError(
        'CHECKOUT_RATE_DEADLINE_EXCEEDED',
        'Required carrier rating exceeded the checkout deadline',
      ))
    }
    abortFromCaller = rejectForDeadline
    if (input.signal?.aborted) rejectForDeadline()
    else input.signal?.addEventListener(
      'abort',
      rejectForDeadline,
      { once: true },
    )
    timer = setTimeout(
      rejectForDeadline,
      Math.max(1, input.deadlineAt - startedAt),
    )
  })

  try {
    const pending = Promise.all(carriers.map(async (selection) => {
      if (controller.signal.aborted) {
        throw new CheckoutShipmentRateError(
          'CHECKOUT_RATE_DEADLINE_EXCEEDED',
          'Required carrier rating exceeded the checkout deadline',
        )
      }
      let result: CheckoutRateProviderResult
      try {
        result = await input.invoke(selection, {
          destination: input.destination,
          parcels,
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) throw error
        throw new CheckoutShipmentRateError(
          'CHECKOUT_RATE_REQUIRED_CARRIER_FAILED',
          `${selection.provider} did not return a usable whole-shipment rate`,
          selection.provider,
        )
      }
      return normalizeProviderResult(
        result,
        selection,
        parcels.length,
        input.currency,
      )
    }))
    const offers = (await Promise.race([pending, timeout])).flat()
    return {
      rateScope: 'multi_package_shipment',
      packageCount: parcels.length,
      requiredProviders: carriers.map(({ provider }) => provider),
      offers: offers.sort((left, right) => (
        left.amountMinor - right.amountMinor
        || left.carrierCode.localeCompare(right.carrierCode)
        || left.serviceLevelCode.localeCompare(right.serviceLevelCode)
      )),
      completedAt: new Date(now()).toISOString(),
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (abortFromCaller) {
      input.signal?.removeEventListener('abort', abortFromCaller)
    }
    controller.abort()
  }
}
