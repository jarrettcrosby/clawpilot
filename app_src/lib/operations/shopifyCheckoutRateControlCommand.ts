import {
  normalizeShopifyCheckoutRateControl,
  type ShopifyCheckoutRateControl,
// @ts-expect-error Node's strip-types gate requires the explicit source extension.
} from './shopifyCheckoutRateControl.ts'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/
const REQUEST_HASH = /^[a-f0-9]{64}$/
const GLOBAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/
const CONTROL_RESULT_VERSION =
  'shopify-checkout-rate-control-command-result-v1' as const

export type ShopifyCheckoutRateControlPendingCommand = {
  accountGlobalId: string
  configGlobalId: string
  idempotencyKey: string
  expectedPolicyRevision: number
  body: {
    expectedRowVersion: number
    checkoutRateControl: ShopifyCheckoutRateControl
    reason: string
  }
}

export type ShopifyCheckoutRateControlCommandResult = {
  version: typeof CONTROL_RESULT_VERSION
  accountGlobalId: string
  configGlobalId: string
  idempotencyKey: string
  requestHash: string
  checkoutRateControl: ShopifyCheckoutRateControl
  rowVersion: number
  policyRevision: number
  providerWrites: 0
}

export type ShopifyCheckoutRateControlCommandServerState = {
  accountGlobalId: string
  configGlobalId: string
  checkoutRateControl: unknown
  rowVersion: number
  policyRevision: number
}

export class ShopifyCheckoutRateControlHttpError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(status: number, message: string, code?: string | null) {
    super(message)
    this.name = 'ShopifyCheckoutRateControlHttpError'
    this.status = status
    this.code = code || null
  }
}

export type ShopifyCheckoutRateControlPendingResolution =
  | 'applied'
  | 'definitive_rejection'
  | 'retain_exact_retry'

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  return Object.keys(value).sort().join('\n')
    === [...expected].sort().join('\n')
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function normalizeShopifyCheckoutRateControlPendingCommand(
  value: unknown,
): ShopifyCheckoutRateControlPendingCommand {
  const command = record(value)
  const body = record(command?.body)
  if (
    !command
    || !body
    || !exactKeys(command, [
      'accountGlobalId',
      'body',
      'configGlobalId',
      'expectedPolicyRevision',
      'idempotencyKey',
    ])
    || !exactKeys(body, [
      'checkoutRateControl',
      'expectedRowVersion',
      'reason',
    ])
    || typeof command.idempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY.test(command.idempotencyKey)
    || typeof command.accountGlobalId !== 'string'
    || !GLOBAL_ID.test(command.accountGlobalId)
    || typeof command.configGlobalId !== 'string'
    || !GLOBAL_ID.test(command.configGlobalId)
    || !Number.isSafeInteger(command.expectedPolicyRevision)
    || Number(command.expectedPolicyRevision) < 1
    || !Number.isSafeInteger(body.expectedRowVersion)
    || Number(body.expectedRowVersion) < 0
    || typeof body.reason !== 'string'
    || body.reason.trim() !== body.reason
    || body.reason.length < 3
    || body.reason.length > 500
    || /[\u0000-\u001f\u007f]/.test(body.reason)
  ) {
    throw new Error('Saved checkout-rate control command is invalid')
  }
  return {
    accountGlobalId: command.accountGlobalId,
    configGlobalId: command.configGlobalId,
    idempotencyKey: command.idempotencyKey,
    expectedPolicyRevision: Number(command.expectedPolicyRevision),
    body: {
      expectedRowVersion: Number(body.expectedRowVersion),
      checkoutRateControl: normalizeShopifyCheckoutRateControl(
        body.checkoutRateControl,
      ),
      reason: body.reason,
    },
  }
}

/**
 * Persist and read back before the first POST. sessionStorage intentionally
 * scopes the recovery boundary to this signed-in browser tab/session.
 */
export function persistShopifyCheckoutRateControlPendingCommand(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  key: string,
  value: ShopifyCheckoutRateControlPendingCommand,
) {
  const command = normalizeShopifyCheckoutRateControlPendingCommand(value)
  const encoded = JSON.stringify(command)
  storage.setItem(key, encoded)
  const retained = storage.getItem(key)
  if (retained !== encoded) {
    throw new Error('Checkout-rate control retry command was not retained')
  }
  const verified = normalizeShopifyCheckoutRateControlPendingCommand(
    JSON.parse(retained),
  )
  if (JSON.stringify(verified) !== encoded) {
    throw new Error('Checkout-rate control retry command failed read-back')
  }
  return verified
}

export function readShopifyCheckoutRateControlPendingCommand(
  storage: Pick<Storage, 'getItem'>,
  key: string,
) {
  const retained = storage.getItem(key)
  return retained
    ? normalizeShopifyCheckoutRateControlPendingCommand(JSON.parse(retained))
    : null
}

export function selectShopifyCheckoutRateControlFormState(input: {
  serverControl: unknown
  pendingCommand: ShopifyCheckoutRateControlPendingCommand | null
  accountGlobalId: string
  configGlobalId: string
}) {
  const pending = input.pendingCommand
    ? normalizeShopifyCheckoutRateControlPendingCommand(input.pendingCommand)
    : null
  if (
    pending
    && (
      pending.accountGlobalId !== input.accountGlobalId
      || pending.configGlobalId !== input.configGlobalId
    )
  ) {
    throw new Error(
      'Saved checkout-rate control command belongs to a different Shopify account',
    )
  }
  return {
    checkoutRateControl: normalizeShopifyCheckoutRateControl(
      pending?.body.checkoutRateControl ?? input.serverControl,
    ),
    reason: pending?.body.reason ?? null,
  }
}

export function shopifyCheckoutRateControlCommandMatchesServerState(input: {
  state: ShopifyCheckoutRateControlCommandServerState | null | undefined
  command: ShopifyCheckoutRateControlPendingCommand
}) {
  const { state, command } = input
  if (
    !state
    || state.accountGlobalId !== command.accountGlobalId
    || state.configGlobalId !== command.configGlobalId
    || state.rowVersion !== command.body.expectedRowVersion + 1
    || state.policyRevision !== command.expectedPolicyRevision + 1
  ) return false
  try {
    return JSON.stringify(normalizeShopifyCheckoutRateControl(
      state.checkoutRateControl,
    )) === JSON.stringify(command.body.checkoutRateControl)
  } catch {
    return false
  }
}

export function shopifyCheckoutRateControlHttpFailureIsDefinitive(
  status: number,
) {
  return status >= 400
    && status < 500
    && status !== 408
    && status !== 425
    && status !== 429
}

export function shopifyCheckoutRateControlPendingResolution(input: {
  state: ShopifyCheckoutRateControlCommandServerState | null | undefined
  command: ShopifyCheckoutRateControlPendingCommand
  failure: unknown
}): ShopifyCheckoutRateControlPendingResolution {
  if (shopifyCheckoutRateControlCommandMatchesServerState(input)) {
    return 'applied'
  }
  if (
    input.failure instanceof ShopifyCheckoutRateControlHttpError
    && shopifyCheckoutRateControlHttpFailureIsDefinitive(
      input.failure.status,
    )
  ) return 'definitive_rejection'
  return 'retain_exact_retry'
}

export function assertShopifyCheckoutRateControlCommandResult(input: {
  value: unknown
  command: ShopifyCheckoutRateControlPendingCommand
  accountGlobalId: string
  configGlobalId: string
}): ShopifyCheckoutRateControlCommandResult {
  const result = record(input.value)
  if (
    !result
    || !exactKeys(result, [
      'accountGlobalId',
      'checkoutRateControl',
      'configGlobalId',
      'idempotencyKey',
      'policyRevision',
      'providerWrites',
      'requestHash',
      'rowVersion',
      'version',
    ])
    || result.version !== CONTROL_RESULT_VERSION
    || input.command.accountGlobalId !== input.accountGlobalId
    || input.command.configGlobalId !== input.configGlobalId
    || result.accountGlobalId !== input.accountGlobalId
    || result.configGlobalId !== input.configGlobalId
    || result.idempotencyKey !== input.command.idempotencyKey
    || typeof result.requestHash !== 'string'
    || !REQUEST_HASH.test(result.requestHash)
    || JSON.stringify(normalizeShopifyCheckoutRateControl(
      result.checkoutRateControl,
    )) !== JSON.stringify(input.command.body.checkoutRateControl)
    || result.rowVersion
      !== input.command.body.expectedRowVersion + 1
    || result.policyRevision
      !== input.command.expectedPolicyRevision + 1
    || result.providerWrites !== 0
  ) {
    throw new Error(
      'The server returned a mismatched checkout-rate control result. The exact retry is still saved; retry or contact support.',
    )
  }
  return result as ShopifyCheckoutRateControlCommandResult
}
