const EXACT_PROVIDER_OBSERVATION_KINDS = new Set([
  'manual_exact_read',
  'webhook_exact_read',
])

const CURRENCY = /^[A-Z]{3}$/u
const INTEGER_MINOR_UNITS = /^-?(?:0|[1-9][0-9]*)$/u

export type CurrentExactProviderOrderMoney = {
  currency: string
  totalMinor: string
}

/**
 * Returns provider header money only when the caller has already selected an
 * exact-read observation as the current provider revision. Line amounts are
 * intentionally not accepted here: an order total must never be reconstructed
 * by summing a potentially adjusted line snapshot.
 */
export function currentExactProviderOrderMoney(input: Readonly<{
  currentProviderObservationKind: string | null
  currency: string | null
  providerTotalMinor: string | null
}>): CurrentExactProviderOrderMoney | null {
  if (
    !input.currentProviderObservationKind
    || !EXACT_PROVIDER_OBSERVATION_KINDS.has(
      input.currentProviderObservationKind,
    )
  ) {
    return null
  }
  const currency = String(input.currency || '').trim()
  const totalMinor = String(input.providerTotalMinor || '').trim()
  const parsedTotalMinor = Number(totalMinor)
  if (
    !CURRENCY.test(currency)
    || !INTEGER_MINOR_UNITS.test(totalMinor)
    || !Number.isSafeInteger(parsedTotalMinor)
  ) {
    return null
  }
  return { currency, totalMinor }
}
