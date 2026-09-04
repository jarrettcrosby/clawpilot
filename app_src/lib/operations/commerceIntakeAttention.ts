export type CommerceIntakeAttentionCandidate = {
  state?: string | null
  normalizedOrderStatus?: string | null
  normalizedFulfillmentStatus?: string | null
  providerStatus?: string | null
  fulfillmentStatus?: string | null
}

const TERMINAL_ORDER_STATES = new Set([
  'cancelled',
  'canceled',
  'closed',
])

const TERMINAL_FULFILLMENT_STATES = new Set([
  'cancelled',
  'canceled',
  'fulfilled',
])

const NO_ACTION_WORKFLOW_STATES = new Set(['promoted'])

function normalizedState(value: string | null | undefined) {
  return String(value || '').trim().toLocaleLowerCase()
}

/**
 * Terminal provider orders are retained for exact history and reconciliation.
 * They cannot create new ClawPilot fulfillment demand, so intake-readiness
 * blockers on these rows are informational rather than operator work.
 */
export function commerceIntakeCandidateIsHistoricalOutcome(
  candidate: CommerceIntakeAttentionCandidate,
) {
  const orderState = normalizedState(
    candidate.normalizedOrderStatus || candidate.providerStatus,
  )
  const fulfillmentState = normalizedState(
    candidate.normalizedFulfillmentStatus || candidate.fulfillmentStatus,
  )
  return TERMINAL_ORDER_STATES.has(orderState)
    || TERMINAL_FULFILLMENT_STATES.has(fulfillmentState)
}

export function commerceIntakeCandidateNeedsOperatorAction(
  candidate: CommerceIntakeAttentionCandidate,
) {
  return !commerceIntakeCandidateIsHistoricalOutcome(candidate)
    && !NO_ACTION_WORKFLOW_STATES.has(normalizedState(candidate.state))
}

export function commerceIntakeHistoricalOutcomeLabel(
  candidate: CommerceIntakeAttentionCandidate,
) {
  const orderState = normalizedState(
    candidate.normalizedOrderStatus || candidate.providerStatus,
  )
  const fulfillmentState = normalizedState(
    candidate.normalizedFulfillmentStatus || candidate.fulfillmentStatus,
  )
  if (
    orderState === 'cancelled'
    || orderState === 'canceled'
    || fulfillmentState === 'cancelled'
    || fulfillmentState === 'canceled'
  ) return 'Cancelled externally'
  if (fulfillmentState === 'fulfilled') return 'Fulfilled externally'
  return 'Closed externally'
}
