export const SHADOW_TRAINING_CONFIRMATION = 'local_training_only' as const

const ORDER_TRAINING_SAFETY_STATES = new Set([
  'disabled',
  'shadow',
  'read_only',
  'active',
  'frozen',
])

export type OperationsShadowTrainingState =
  | 'enabled'
  | 'planned'
  | 'released'
  | 'picked'
  | 'packed'
  | 'labeled'
  | 'completed'
  | 'reset'
  | 'reset_blocked'

export type OperationsShadowTrainingAction =
  | 'plan'
  | 'release'
  | 'confirm-picks'
  | 'verify-pack'
  | 'complete'
  | 'undo'
  | 'reset'

export class OperationsShadowTrainingError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status = 409, code = 'OPERATIONS_SHADOW_TRAINING_INVALID') {
    super(message)
    this.name = 'OperationsShadowTrainingError'
    this.status = status
    this.code = code
  }
}

export function assertShadowTrainingEligibility(input: {
  activationState: string
  orderStatus: string
  sourceProvider: string
  integrationType: string
  accountStatus: string
  accountEnvironment: string
  credentialVerificationStatus: string
}) {
  if (!ORDER_TRAINING_SAFETY_STATES.has(input.activationState)) {
    throw new OperationsShadowTrainingError(
      'Order training requires a current Operations safety profile.',
      409,
      'OPERATIONS_ORDER_TRAINING_SAFETY_PROFILE_REQUIRED',
    )
  }
  if (input.orderStatus !== 'imported') {
    throw new OperationsShadowTrainingError(
      'Only an untouched imported order can begin a training run.',
      409,
      'OPERATIONS_SHADOW_TRAINING_IMPORTED_ORDER_REQUIRED',
    )
  }
  if (input.sourceProvider !== 'shopify' && input.sourceProvider !== 'faire') {
    throw new OperationsShadowTrainingError(
      'Training requires an imported Shopify or Faire order.',
      409,
      'OPERATIONS_SHADOW_TRAINING_PROVIDER_REQUIRED',
    )
  }
  if (
    input.integrationType !== 'commerce'
    || input.accountStatus !== 'active'
    || !['sandbox', 'production'].includes(input.accountEnvironment)
    || input.credentialVerificationStatus !== 'verified'
  ) {
    throw new OperationsShadowTrainingError(
      'The exact order must belong to a connected, verified commerce account.',
      409,
      'OPERATIONS_SHADOW_TRAINING_CONNECTION_REQUIRED',
    )
  }
  // Both connected dev stores (sandbox) and production stores are eligible.
  // Production is safe only because the overlay has a hard zero-commerce-write
  // contract. Mock fixtures are not connected stores and are intentionally
  // excluded.
}

export function assertShadowTrainingCommandState(input: {
  state: OperationsShadowTrainingState
  action: OperationsShadowTrainingAction
}) {
  const permitted: Record<OperationsShadowTrainingAction, OperationsShadowTrainingState[]> = {
    plan: ['enabled'],
    release: ['planned'],
    'confirm-picks': ['released'],
    'verify-pack': ['picked'],
    complete: ['packed'],
    undo: ['released', 'picked', 'packed', 'completed'],
    reset: [
      'enabled', 'planned', 'released', 'picked', 'packed', 'labeled',
      'completed', 'reset_blocked',
    ],
  }
  if (!permitted[input.action].includes(input.state)) {
    throw new OperationsShadowTrainingError(
      `Training action ${input.action} is not available from ${input.state}.`,
      409,
      'OPERATIONS_SHADOW_TRAINING_TRANSITION_INVALID',
    )
  }
}

export function shadowTrainingAvailableActions(
  state: OperationsShadowTrainingState,
): OperationsShadowTrainingAction[] {
  const actions: OperationsShadowTrainingAction[] = []
  for (const action of [
    'plan', 'release', 'confirm-picks', 'verify-pack',
    'complete', 'undo', 'reset',
  ] as const) {
    try {
      assertShadowTrainingCommandState({ state, action })
      actions.push(action)
    } catch (error) {
      if (!(error instanceof OperationsShadowTrainingError)) throw error
    }
  }
  return actions
}

export function shadowTrainingUndoTarget(
  state: OperationsShadowTrainingState,
): Extract<OperationsShadowTrainingState, 'planned' | 'released' | 'picked' | 'packed'> {
  const target = {
    released: 'planned',
    picked: 'released',
    packed: 'picked',
    completed: 'packed',
  } as const
  const result = target[state as keyof typeof target]
  if (!result) {
    throw new OperationsShadowTrainingError(
      `The last training step cannot be undone from ${state}. Reset the run to start over.`,
      409,
      'OPERATIONS_SHADOW_TRAINING_UNDO_UNAVAILABLE',
    )
  }
  return result
}

export function assertShadowTrainingSandboxCarrierBeforeIo(input: {
  environment: string
  purpose: string
  provider: string
}) {
  if (
    input.environment !== 'sandbox'
    || input.purpose !== 'sandbox_rate_test'
    || (input.provider !== 'ups_rest' && input.provider !== 'fedex_rest')
  ) {
    throw new OperationsShadowTrainingError(
      'Training label execution requires exact UPS or FedEx sandbox rate-test evidence.',
      409,
      'OPERATIONS_SHADOW_TRAINING_SANDBOX_CARRIER_REQUIRED',
    )
  }
}
