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

export type CheckoutRateCarrierParcel = Omit<
  CheckoutRateParcel,
  'packageKey'
>

export type CheckoutRateDestination = {
  name: string | null
  line1: string | null
  line2: string | null
  city: string | null
  region: string | null
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

export type CheckoutRateProviderAttempt = {
  provider: CheckoutRateCarrierProvider
  carrierAccountGlobalId: string
  status: 'succeeded' | 'degraded'
  failureCode: string | null
  rateEvidenceGlobalId: string
}

export type CheckoutShipmentRateResult = {
  rateScope: 'multi_package_shipment'
  packageCount: number
  configuredProviders: CheckoutRateCarrierProvider[]
  successfulProviders: CheckoutRateCarrierProvider[]
  providerAttempts: CheckoutRateProviderAttempt[]
  offers: CheckoutRateOffer[]
  completedAt: string
}

export type CheckoutPlanRateCandidate = {
  candidateKey: string
  parcels: CheckoutRateParcel[]
  materialCostMinor: number
  unusedCubeMm3: number
}

export type CheckoutPlanRateObjective =
  | 'landed_price'
  | 'package_count'
  | 'unused_cube'

export type CheckoutPlanRateObjectivePolicy = {
  version: string
  maxCandidates: number
  objectivePriority: CheckoutPlanRateObjective[]
  handlingCostMinorPerPackage: number
  handlingCostCurrency: string
}

export type CheckoutPlanRateEvaluation = {
  candidateKey: string
  packageCount: number
  materialCostMinor: number
  handlingCostMinor: number
  unusedCubeMm3: number
  offer: CheckoutRateOffer
  landedPriceMinor: number
}

export type CheckoutPlanRateCandidateAttempt = {
  candidate: CheckoutPlanRateCandidate
  status: 'succeeded' | 'degraded'
  result: CheckoutShipmentRateResult | null
  evaluation: CheckoutPlanRateEvaluation | null
  failureCode: string | null
}

export type OptimizedCheckoutPlanRateResult = {
  objectiveVersion: string
  selectedCandidate: CheckoutPlanRateCandidate
  selectedOffer: CheckoutRateOffer
  selectedRateResult: CheckoutShipmentRateResult
  selectedEvaluation: CheckoutPlanRateEvaluation
  candidateEvaluations: CheckoutPlanRateEvaluation[]
  candidateAttempts: CheckoutPlanRateCandidateAttempt[]
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
const EVIDENCE_GLOBAL_ID = /^grq[0-9]{7}$/
const CURRENCY = /^[A-Z]{3}$/
const DECIMAL_MONEY = /^(?:0|[1-9][0-9]{0,12})(?:\.[0-9]{1,2})?$/
export const CHECKOUT_RATE_ALTERNATIVE_BUDGET_MS = 1_000
const CHECKOUT_RATE_EVIDENCE_GRACE_MS = 750

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

function safeProviderFailureCode(error: unknown) {
  const code = error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : null
  return typeof code === 'string' && /^[A-Z0-9_]{3,100}$/.test(code)
    ? code
    : 'CHECKOUT_RATE_PROVIDER_FAILED'
}

function safeProviderRateEvidenceGlobalId(error: unknown) {
  const globalId = error && typeof error === 'object'
    ? (error as { rateEvidenceGlobalId?: unknown }).rateEvidenceGlobalId
    : null
  return typeof globalId === 'string' && EVIDENCE_GLOBAL_ID.test(globalId)
    ? globalId
    : null
}

function providerResultRateEvidenceGlobalId(
  offers: CheckoutRateOffer[],
  provider: CheckoutRateCarrierProvider,
) {
  const evidenceGlobalIds = new Set(
    offers.map(({ evidenceGlobalId }) => evidenceGlobalId),
  )
  if (evidenceGlobalIds.size !== 1) {
    rateError(
      'CHECKOUT_RATE_PROVIDER_RESPONSE_INVALID',
      'Carrier services must share one durable whole-shipment rate evidence record',
      provider,
    )
  }
  return offers[0]!.evidenceGlobalId
}

async function providerOutcomesWithin<T>(
  pending: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      pending,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Calls every configured carrier exactly once with the complete package array.
 * A transient provider failure is retained as degraded evidence and cannot
 * suppress another provider's usable whole-shipment offers. The shipment quote
 * fails when no provider succeeds or a degraded attempt lacks durable evidence.
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
      parcels: CheckoutRateCarrierParcel[]
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
  const carrierParcels: CheckoutRateCarrierParcel[] = parcels.map(
    (parcel) => ({
      description: parcel.description,
      exteriorInches: { ...parcel.exteriorInches },
      grossPounds: parcel.grossPounds,
    }),
  )
  const carriers = normalizeCarriers(input.carriers)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  let abortFromCaller: (() => void) | null = null
  let internalDeadlineExpired = false
  type ProviderAttemptOutcome = Omit<
    CheckoutRateProviderAttempt,
    'rateEvidenceGlobalId'
  > & {
    rateEvidenceGlobalId: string | null
  }
  type ProviderOutcome = {
    attempt: ProviderAttemptOutcome
    offers: CheckoutRateOffer[]
    error: unknown
  }
  const settledByProvider = new Map<
    CheckoutRateCarrierProvider,
    ProviderOutcome
  >()
  let providerWork: Promise<ProviderOutcome[]> | null = null

  const timeout = new Promise<ProviderOutcome[]>((resolve, reject) => {
    const rejectForCallerAbort = () => {
      controller.abort()
      reject(new CheckoutShipmentRateError(
        'CHECKOUT_RATE_DEADLINE_EXCEEDED',
        'Required carrier rating exceeded the checkout deadline',
      ))
    }
    const finishAtDeadline = async () => {
      internalDeadlineExpired = true
      controller.abort()
      const completedOutcomes = providerWork
        ? await providerOutcomesWithin(
            providerWork,
            CHECKOUT_RATE_EVIDENCE_GRACE_MS,
          )
        : null
      const outcomes = completedOutcomes ?? carriers.map((selection) => (
        settledByProvider.get(selection.provider) ?? {
          attempt: {
            provider: selection.provider,
            carrierAccountGlobalId: selection.carrierAccountGlobalId,
            status: 'degraded' as const,
            failureCode: 'CHECKOUT_RATE_DEADLINE_EXCEEDED',
            rateEvidenceGlobalId: null,
          },
          offers: [],
          error: null,
        }
      ))
      if (outcomes.some((outcome) => outcome.attempt.status === 'succeeded')) {
        resolve(outcomes)
        return
      }
      reject(new CheckoutShipmentRateError(
        'CHECKOUT_RATE_DEADLINE_EXCEEDED',
        'Configured carrier rating exceeded the checkout deadline',
      ))
    }
    abortFromCaller = rejectForCallerAbort
    if (input.signal?.aborted) rejectForCallerAbort()
    else input.signal?.addEventListener(
      'abort',
      rejectForCallerAbort,
      { once: true },
    )
    timer = setTimeout(
      () => {
        void finishAtDeadline()
      },
      Math.max(1, input.deadlineAt - startedAt),
    )
  })

  try {
    providerWork = Promise.all(carriers.map(async (
      selection,
    ): Promise<ProviderOutcome> => {
      try {
        if (controller.signal.aborted) {
          throw new CheckoutShipmentRateError(
            'CHECKOUT_RATE_DEADLINE_EXCEEDED',
            'Required carrier rating exceeded the checkout deadline',
          )
        }
        const result = await input.invoke(selection, {
          destination: input.destination,
          parcels: carrierParcels,
          signal: controller.signal,
        })
        const offers = normalizeProviderResult(
          result,
          selection,
          parcels.length,
          input.currency,
        )
        const outcome = {
          attempt: {
            provider: selection.provider,
            carrierAccountGlobalId: selection.carrierAccountGlobalId,
            status: 'succeeded' as const,
            failureCode: null,
            rateEvidenceGlobalId: providerResultRateEvidenceGlobalId(
              offers,
              selection.provider,
            ),
          },
          offers,
          error: null,
        }
        settledByProvider.set(selection.provider, outcome)
        return outcome
      } catch (error) {
        const outcome = {
          attempt: {
            provider: selection.provider,
            carrierAccountGlobalId: selection.carrierAccountGlobalId,
            status: 'degraded' as const,
            failureCode: safeProviderFailureCode(error),
            rateEvidenceGlobalId: safeProviderRateEvidenceGlobalId(error),
          },
          offers: [],
          error,
        }
        settledByProvider.set(selection.provider, outcome)
        return outcome
      }
    }))
    const outcomes = await Promise.race([providerWork, timeout])
    const offers = outcomes.flatMap((outcome) => outcome.offers)
    if (!offers.length) {
      if (internalDeadlineExpired) {
        throw new CheckoutShipmentRateError(
          'CHECKOUT_RATE_DEADLINE_EXCEEDED',
          'Configured carrier rating exceeded the checkout deadline',
        )
      }
      const onlyFailure = outcomes.length === 1
        ? outcomes[0]?.error
        : null
      if (onlyFailure instanceof CheckoutShipmentRateError) {
        throw onlyFailure
      }
      throw new CheckoutShipmentRateError(
        'CHECKOUT_RATE_ALL_PROVIDERS_FAILED',
        'No configured carrier returned a usable whole-shipment rate',
      )
    }
    const providerAttempts = outcomes.map((outcome) => {
      if (!outcome.attempt.rateEvidenceGlobalId) {
        throw new CheckoutShipmentRateError(
          'CHECKOUT_RATE_PROVIDER_EVIDENCE_REQUIRED',
          `${outcome.attempt.provider} did not retain durable rate evidence`,
          outcome.attempt.provider,
        )
      }
      return {
        ...outcome.attempt,
        rateEvidenceGlobalId: outcome.attempt.rateEvidenceGlobalId,
      } satisfies CheckoutRateProviderAttempt
    })
    return {
      rateScope: 'multi_package_shipment',
      packageCount: parcels.length,
      configuredProviders: carriers.map(({ provider }) => provider),
      successfulProviders: outcomes.flatMap((outcome) => (
        outcome.attempt.status === 'succeeded'
          ? [outcome.attempt.provider]
          : []
      )),
      providerAttempts,
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

function exactNonnegative(value: unknown, label: string) {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < 0
    || Number(value) > Number.MAX_SAFE_INTEGER
  ) {
    rateError(
      'CHECKOUT_RATE_OPTIMIZER_INPUT_INVALID',
      `${label} must be an exact nonnegative integer`,
    )
  }
  return Number(value)
}

function comparePlanRateEvaluation(
  left: CheckoutPlanRateEvaluation,
  right: CheckoutPlanRateEvaluation,
  objectivePriority: CheckoutPlanRateObjective[],
) {
  for (const objective of objectivePriority) {
    const compared = objective === 'landed_price'
      ? left.landedPriceMinor - right.landedPriceMinor
      : objective === 'package_count'
        ? left.packageCount - right.packageCount
        : left.unusedCubeMm3 - right.unusedCubeMm3
    if (compared !== 0) return compared
  }
  return (
    left.candidateKey.localeCompare(right.candidateKey)
    || left.offer.carrierCode.localeCompare(right.offer.carrierCode)
    || left.offer.serviceLevelCode.localeCompare(
      right.offer.serviceLevelCode,
    )
  )
}

function evaluateCandidateRate(
  candidate: CheckoutPlanRateCandidate,
  result: CheckoutShipmentRateResult,
  policy: CheckoutPlanRateObjectivePolicy,
  handlingCostMinorPerPackage: number,
) {
  const handlingCostMinor =
    handlingCostMinorPerPackage * result.packageCount
  if (!Number.isSafeInteger(handlingCostMinor)) {
    rateError(
      'CHECKOUT_RATE_OPTIMIZER_INPUT_INVALID',
      'Handling cost exceeds the supported exact range',
    )
  }
  const evaluations = result.offers.map((offer) => {
    const landedPriceMinor =
      offer.amountMinor
      + candidate.materialCostMinor
      + handlingCostMinor
    if (!Number.isSafeInteger(landedPriceMinor)) {
      rateError(
        'CHECKOUT_RATE_OPTIMIZER_INPUT_INVALID',
        'Landed price exceeds the supported exact range',
      )
    }
    return {
      candidateKey: candidate.candidateKey,
      packageCount: result.packageCount,
      materialCostMinor: candidate.materialCostMinor,
      handlingCostMinor,
      unusedCubeMm3: candidate.unusedCubeMm3,
      offer,
      landedPriceMinor,
    } satisfies CheckoutPlanRateEvaluation
  }).sort((left, right) => comparePlanRateEvaluation(
    left,
    right,
    policy.objectivePriority,
  ))
  if (!evaluations[0]) {
    rateError(
      'CHECKOUT_RATE_OPTIMIZER_RESULT_INVALID',
      'A successful whole-shipment candidate returned no offers',
    )
  }
  return evaluations[0]
}

function degradedProviderFailureCode(result: CheckoutShipmentRateResult) {
  return result.providerAttempts.find(
    (attempt) => attempt.status === 'degraded',
  )?.failureCode ?? null
}

function alternativeFailureCode(error: unknown) {
  const code = error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : null
  return typeof code === 'string' && /^[A-Z0-9_]{3,100}$/.test(code)
    ? code
    : 'CHECKOUT_RATE_ALTERNATIVE_FAILED'
}

/**
 * Rates the first feasible plan as the authoritative baseline. Optional
 * bounded alternatives are then rated best-effort under a separate deadline.
 * Every successful candidate is still one complete multi-package shipment:
 * provider services are never stitched package-by-package. Baseline failure
 * (including a missing required carrier) fails closed; an optional candidate
 * failure is retained as degraded decision evidence.
 */
export async function rateOptimizedCheckoutPlans(input: {
  destination: CheckoutRateDestination
  candidates: CheckoutPlanRateCandidate[]
  carriers: CheckoutRateCarrierSelection[]
  currency: string
  deadlineAt: number
  policy: CheckoutPlanRateObjectivePolicy
  signal?: AbortSignal
  alternativeBudgetMs?: number
  invoke: (
    selection: CheckoutRateCarrierSelection,
    request: {
      destination: CheckoutRateDestination
      parcels: CheckoutRateCarrierParcel[]
      signal: AbortSignal
    },
  ) => Promise<CheckoutRateProviderResult>
  now?: () => number
}): Promise<OptimizedCheckoutPlanRateResult> {
  if (
    !Array.isArray(input.candidates)
    || input.candidates.length < 1
    || input.candidates.length > 4
    || input.candidates.length > input.policy.maxCandidates
  ) {
    rateError(
      'CHECKOUT_RATE_OPTIMIZER_INPUT_INVALID',
      'Checkout optimization requires a bounded candidate set',
    )
  }
  const expectedObjectives: CheckoutPlanRateObjective[] = [
    'landed_price',
    'package_count',
    'unused_cube',
  ]
  if (
    typeof input.policy.version !== 'string'
    || !input.policy.version.trim()
    || !Number.isSafeInteger(input.policy.maxCandidates)
    || input.policy.maxCandidates < 1
    || input.policy.maxCandidates > 4
    || !Array.isArray(input.policy.objectivePriority)
    || input.policy.objectivePriority.length !== expectedObjectives.length
    || new Set(input.policy.objectivePriority).size
      !== expectedObjectives.length
    || input.policy.objectivePriority.some(
      (objective) => !expectedObjectives.includes(objective),
    )
    || !CURRENCY.test(input.policy.handlingCostCurrency)
  ) {
    rateError(
      'CHECKOUT_RATE_OPTIMIZER_POLICY_INVALID',
      'Checkout optimization policy is invalid',
    )
  }
  const handlingCostMinorPerPackage = exactNonnegative(
    input.policy.handlingCostMinorPerPackage,
    'Handling cost per package',
  )
  if (input.policy.handlingCostCurrency !== input.currency) {
    rateError(
      'CHECKOUT_RATE_OPTIMIZER_CURRENCY_MISMATCH',
      'Handling cost currency must match the checkout rating currency',
    )
  }
  const candidateKeys = new Set<string>()
  const candidates = input.candidates.map((candidate) => {
    if (
      !candidate
      || !PACKAGE_KEY.test(candidate.candidateKey)
      || candidateKeys.has(candidate.candidateKey)
    ) {
      rateError(
        'CHECKOUT_RATE_OPTIMIZER_INPUT_INVALID',
        'Checkout carton candidates require unique stable keys',
      )
    }
    candidateKeys.add(candidate.candidateKey)
    return {
      ...candidate,
      materialCostMinor: exactNonnegative(
        candidate.materialCostMinor,
        'Material cost',
      ),
      unusedCubeMm3: exactNonnegative(
        candidate.unusedCubeMm3,
        'Unused package cube',
      ),
    }
  })
  const alternativeBudgetMs =
    input.alternativeBudgetMs ?? CHECKOUT_RATE_ALTERNATIVE_BUDGET_MS
  if (
    !Number.isSafeInteger(alternativeBudgetMs)
    || alternativeBudgetMs < 10
    || alternativeBudgetMs > 5_000
  ) {
    rateError(
      'CHECKOUT_RATE_OPTIMIZER_INPUT_INVALID',
      'Alternative rating budget must be between 10 and 5000 milliseconds',
    )
  }
  const now = input.now ?? Date.now
  const baselineCandidate = candidates[0]
  const baselineResult = await rateCheckoutShipment({
    destination: input.destination,
    parcels: baselineCandidate.parcels,
    carriers: input.carriers,
    currency: input.currency,
    deadlineAt: input.deadlineAt,
    signal: input.signal,
    invoke: input.invoke,
    now: input.now,
  })
  const baselineEvaluation = evaluateCandidateRate(
    baselineCandidate,
    baselineResult,
    input.policy,
    handlingCostMinorPerPackage,
  )
  const baselineFailureCode = degradedProviderFailureCode(baselineResult)
  const candidateAttempts: CheckoutPlanRateCandidateAttempt[] = [{
    candidate: baselineCandidate,
    status: baselineFailureCode ? 'degraded' : 'succeeded',
    result: baselineResult,
    evaluation: baselineEvaluation,
    failureCode: baselineFailureCode,
  }]
  const rated: Array<{
    candidate: CheckoutPlanRateCandidate
    result: CheckoutShipmentRateResult
  }> = [{
    candidate: baselineCandidate,
    result: baselineResult,
  }]
  const alternatives = candidates.slice(1)
  if (alternatives.length) {
    const remainingAtStart = input.deadlineAt - now()
    const alternativeDeadlineAt = Math.min(
      input.deadlineAt,
      now() + alternativeBudgetMs,
    )
    if (remainingAtStart <= 0 || alternativeDeadlineAt <= now()) {
      for (const candidate of alternatives) {
        candidateAttempts.push({
          candidate,
          status: 'degraded',
          result: null,
          evaluation: null,
          failureCode: 'CHECKOUT_RATE_ALTERNATIVE_BUDGET_EXHAUSTED',
        })
      }
    } else {
      const settled = await Promise.allSettled(alternatives.map(
        async (candidate) => ({
          candidate,
          result: await rateCheckoutShipment({
            destination: input.destination,
            parcels: candidate.parcels,
            carriers: input.carriers,
            currency: input.currency,
            deadlineAt: alternativeDeadlineAt,
            signal: input.signal,
            invoke: input.invoke,
            now: input.now,
          }),
        }),
      ))
      settled.forEach((outcome, index) => {
        const candidate = alternatives[index]
        if (outcome.status === 'rejected') {
          candidateAttempts.push({
            candidate,
            status: 'degraded',
            result: null,
            evaluation: null,
            failureCode: alternativeFailureCode(outcome.reason),
          })
          return
        }
        try {
          const evaluation = evaluateCandidateRate(
            candidate,
            outcome.value.result,
            input.policy,
            handlingCostMinorPerPackage,
          )
          rated.push(outcome.value)
          const providerFailureCode = degradedProviderFailureCode(
            outcome.value.result,
          )
          candidateAttempts.push({
            candidate,
            status: providerFailureCode ? 'degraded' : 'succeeded',
            result: outcome.value.result,
            evaluation,
            failureCode: providerFailureCode,
          })
        } catch (error) {
          candidateAttempts.push({
            candidate,
            status: 'degraded',
            result: outcome.value.result,
            evaluation: null,
            failureCode: alternativeFailureCode(error),
          })
        }
      })
    }
  }
  const candidateEvaluations = candidateAttempts
    .flatMap((attempt) => attempt.evaluation ? [attempt.evaluation] : [])
    .sort((left, right) => (
    comparePlanRateEvaluation(
      left,
      right,
      input.policy.objectivePriority,
    )
  ))
  const selectedEvaluation = candidateEvaluations[0]
  const selected = rated.find(
    ({ candidate }) => (
      candidate.candidateKey === selectedEvaluation.candidateKey
    ),
  )
  if (!selected) {
    rateError(
      'CHECKOUT_RATE_OPTIMIZER_RESULT_INVALID',
      'Selected checkout carton plan is unavailable',
    )
  }
  return {
    objectiveVersion: input.policy.version,
    selectedCandidate: selected.candidate,
    selectedOffer: selectedEvaluation.offer,
    selectedRateResult: selected.result,
    selectedEvaluation,
    candidateEvaluations,
    candidateAttempts,
  }
}
