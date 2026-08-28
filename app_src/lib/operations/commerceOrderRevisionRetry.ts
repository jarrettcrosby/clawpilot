export function commerceOrderRevisionRefreshNeedsNewIdempotencyKey(
  payload: unknown,
) {
  return Boolean(
    payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && 'retryWithNewIdempotencyKey' in payload
    && payload.retryWithNewIdempotencyKey === true,
  )
}
