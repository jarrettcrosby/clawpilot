const COMMERCE_FULFILLMENT_RECONCILIATION_REQUIRED =
  'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED'

const FAIRE_AUTOMATIC_RECONCILIATION_ERROR_CODES = new Set([
  'FAIRE_REQUEST_TIMEOUT',
  'FAIRE_RATE_LIMITED',
  'FAIRE_RESPONSE_INVALID',
  'FAIRE_RESPONSE_TOO_LARGE',
  'FAIRE_UPSTREAM_UNAVAILABLE',
  '40001',
  '40P01',
])

export type CommerceFulfillmentRecoveryState =
  | 'queued'
  | 'processing'
  | 'failed'

export function commerceFulfillmentRecoveryMode(input: {
  provider: string
  priorState: CommerceFulfillmentRecoveryState
  priorErrorCode: string | null
  hasProviderAttempt: boolean
  usesSafeShopifyAttemptProtocol: boolean
  usesSafeFaireAttemptProtocol: boolean
}): 'execute' | 'reconcile_only' {
  const unresolvedFailure = (
    input.priorState === 'failed'
    && input.priorErrorCode ===
      COMMERCE_FULFILLMENT_RECONCILIATION_REQUIRED
  )
  if (input.provider === 'shopify') {
    return (
      input.hasProviderAttempt
      || (
        input.priorState === 'processing'
        && !input.usesSafeShopifyAttemptProtocol
      )
      || (
        input.priorState === 'failed'
        && (
          unresolvedFailure
          || !input.usesSafeShopifyAttemptProtocol
        )
      )
    ) ? 'reconcile_only' : 'execute'
  }
  if (input.provider === 'faire') {
    return (
      input.hasProviderAttempt
      || !input.usesSafeFaireAttemptProtocol
      || unresolvedFailure
    ) ? 'reconcile_only' : 'execute'
  }
  return input.priorState === 'processing' || unresolvedFailure
    ? 'reconcile_only'
    : 'execute'
}

export function faireFulfillmentErrorAllowsAutomaticReconciliation(
  error: unknown,
) {
  if (!error || typeof error !== 'object') return false
  if ('retryable' in error && error.retryable === true) return true
  if (!('code' in error)) return false
  return FAIRE_AUTOMATIC_RECONCILIATION_ERROR_CODES.has(
    String(error.code || ''),
  )
}
