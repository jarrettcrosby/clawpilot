export const AUTOMATIC_FAIRE_ORDER_MAX_SOURCE_AGE_MS =
  48 * 60 * 60 * 1_000

export const AUTOMATIC_FAIRE_ORDER_MAX_FUTURE_SKEW_MS =
  5 * 60 * 1_000

function timestamp(value: Date | string | null) {
  if (value === null) return Number.NaN
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

/**
 * A staged Faire order is eligible for automatic local promotion only while
 * both the provider source and the captured observation remain current. The
 * current-time checks are essential on an idempotent stage replay: intake
 * evidence is retained for 30 days, but automatic promotion is limited to the
 * first 48 hours.
 */
export function automaticFaireOrderSourceIsFresh(input: {
  providerCreatedAt: Date | string | null
  observedAt: Date | string | null
  nowMs?: number
}) {
  const providerCreatedAt = timestamp(input.providerCreatedAt)
  const observedAt = timestamp(input.observedAt)
  const now = input.nowMs ?? Date.now()
  if (
    !Number.isFinite(providerCreatedAt)
    || !Number.isFinite(observedAt)
    || !Number.isFinite(now)
  ) return false
  return (
    providerCreatedAt <= observedAt
    && observedAt <= now
    && observedAt - providerCreatedAt
      <= AUTOMATIC_FAIRE_ORDER_MAX_SOURCE_AGE_MS
    && providerCreatedAt - observedAt
      <= AUTOMATIC_FAIRE_ORDER_MAX_FUTURE_SKEW_MS
    && now - providerCreatedAt
      <= AUTOMATIC_FAIRE_ORDER_MAX_SOURCE_AGE_MS
    && now - observedAt
      <= AUTOMATIC_FAIRE_ORDER_MAX_SOURCE_AGE_MS
  )
}
