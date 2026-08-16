export type CommerceStoreSyncDesiredState = 'running' | 'paused'

export type CommerceStoreSyncEffectiveReason =
  | 'OPERATIONS_DISABLED_OVERRIDE'
  | 'OPERATIONS_FROZEN_OVERRIDE'
  | 'STORE_SYNC_CONTROL_MISSING'
  | 'STORE_SYNC_ACCOUNT_UNAVAILABLE'
  | 'STORE_SYNC_EXPLICIT_RUNNING'
  | 'STORE_SYNC_EXPLICIT_PAUSED'
  | 'STORE_SYNC_LEGACY_SHADOW_RUNNING'
  | 'STORE_SYNC_LEGACY_ACTIVE_RUNNING'
  | 'STORE_SYNC_LEGACY_READ_ONLY_PAUSED'

export type CommerceStoreSyncEffectiveState = 'running' | 'paused'

export type CommerceStoreSyncControl = {
  accountGlobalId: string
  provider: 'shopify' | 'faire'
  environment: 'mock' | 'sandbox' | 'production'
  displayName: string
  accountStatus: 'active' | 'disabled' | 'error'
  desiredState: CommerceStoreSyncDesiredState
  effectiveState: CommerceStoreSyncEffectiveState
  effectiveReason: CommerceStoreSyncEffectiveReason
  effectiveReasonLabel: string
  explicitChoice: boolean
  revision: number
  reason: string
  updatedAt: string
}

export type CommerceStoreSyncUpdateResult = {
  control: CommerceStoreSyncControl
}

export type CommerceStoreSyncPendingCommand = {
  accountGlobalId: string
  desiredState: CommerceStoreSyncDesiredState
  expectedDesiredState: CommerceStoreSyncDesiredState
  expectedRevision: number
  reason: string
  idempotencyKey: string
}

export function commerceStoreSyncControlMatchesCommand(
  control: CommerceStoreSyncControl,
  command: CommerceStoreSyncPendingCommand,
) {
  return control.accountGlobalId === command.accountGlobalId
    && control.desiredState === command.desiredState
    && control.explicitChoice === true
    && control.revision === command.expectedRevision + 1
}

export const COMMERCE_STORE_SYNC_EFFECTIVE_REASON_LABELS:
Record<CommerceStoreSyncEffectiveReason, string> = {
  OPERATIONS_DISABLED_OVERRIDE:
    'Paused because Operations is Disabled (emergency override).',
  OPERATIONS_FROZEN_OVERRIDE:
    'Paused because Operations is Frozen (emergency override).',
  STORE_SYNC_CONTROL_MISSING:
    'Paused because this connection has no Store sync control.',
  STORE_SYNC_ACCOUNT_UNAVAILABLE:
    'Paused because this commerce connection is not active.',
  STORE_SYNC_EXPLICIT_RUNNING:
    'Running by an explicit Store sync choice.',
  STORE_SYNC_EXPLICIT_PAUSED:
    'Paused by an explicit Store sync choice.',
  STORE_SYNC_LEGACY_SHADOW_RUNNING:
    'Running from the legacy Shadow default until explicitly changed.',
  STORE_SYNC_LEGACY_ACTIVE_RUNNING:
    'Running from the legacy Active default until explicitly changed.',
  STORE_SYNC_LEGACY_READ_ONLY_PAUSED:
    'Paused from the legacy Read only default until explicitly changed.',
}

const RUNNING_REASONS = new Set<CommerceStoreSyncEffectiveReason>([
  'STORE_SYNC_EXPLICIT_RUNNING',
  'STORE_SYNC_LEGACY_SHADOW_RUNNING',
  'STORE_SYNC_LEGACY_ACTIVE_RUNNING',
])

export function commerceStoreSyncEffectiveState(
  reason: CommerceStoreSyncEffectiveReason,
): CommerceStoreSyncEffectiveState {
  return RUNNING_REASONS.has(reason) ? 'running' : 'paused'
}

export function commerceStoreSyncReasonLabel(
  reason: CommerceStoreSyncEffectiveReason,
) {
  return COMMERCE_STORE_SYNC_EFFECTIVE_REASON_LABELS[reason]
}

export function commerceStoreSyncRunningSql(accountAlias = 'account') {
  if (!/^[a-z_][a-z0-9_]*$/i.test(accountAlias)) {
    throw new Error('Store sync SQL account alias is invalid')
  }
  return `operations_commerce_store_sync_is_running(${accountAlias}.organization_id, ${accountAlias}.id)`
}
