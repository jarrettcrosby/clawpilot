export type ShippingOneOffCommandAction =
  | 'pack'
  | 'packed-rate'
  | 'purchase'
  | 'void'
  | 'print'

export type ShippingOneOffRetainedCommand = {
  key: string
  body: string
  responseBindingRequired?: true
}

type CommandStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function expectedBodyAction(action: ShippingOneOffCommandAction) {
  if (action === 'pack') return 'confirm-pack'
  if (action === 'packed-rate') return 'refresh-packed-rates'
  if (action === 'purchase') return 'purchase-group'
  if (action === 'print') return 'recover-label-print'
  return 'void-group'
}

export function readShippingOneOffRetainedCommand(
  storage: CommandStorage | null,
  action: ShippingOneOffCommandAction,
  orderGlobalId: string,
  storageKey: string,
): ShippingOneOffRetainedCommand | null {
  if (!storage) return null
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) || 'null') as {
      key?: unknown
      body?: unknown
      responseBindingRequired?: unknown
    } | null
    if (
      parsed
      && typeof parsed.key === 'string'
      && parsed.key.startsWith(`shipping-one-off-${action}:${orderGlobalId}:`)
      && typeof parsed.body === 'string'
    ) {
      const body = JSON.parse(parsed.body) as {
        action?: unknown
        orderGlobalId?: unknown
      } | null
      if (
        body
        && body.action === expectedBodyAction(action)
        && body.orderGlobalId === orderGlobalId
      ) {
        return {
          key: parsed.key,
          body: parsed.body,
          ...(parsed.responseBindingRequired === true
            ? { responseBindingRequired: true as const }
            : {}),
        }
      }
    }
    storage.removeItem(storageKey)
  } catch {
    // Browser-local evidence that cannot be read or removed is never replayed.
  }
  return null
}

export function writeShippingOneOffRetainedCommand(
  storage: CommandStorage | null,
  storageKey: string,
  command: ShippingOneOffRetainedCommand | null,
) {
  if (!storage) return false
  try {
    if (command) storage.setItem(storageKey, JSON.stringify(command))
    else storage.removeItem(storageKey)
    return true
  } catch {
    return false
  }
}

export function shippingOneOffRetainedCommandsMatch(
  left: ShippingOneOffRetainedCommand | null,
  right: ShippingOneOffRetainedCommand | null,
) {
  if (left === null || right === null) return left === right
  return typeof left.key === 'string'
    && typeof left.body === 'string'
    && typeof right.key === 'string'
    && typeof right.body === 'string'
    && left.key === right.key
    && left.body === right.body
}

export function replaceShippingOneOffRetainedCommandIfExact(
  storage: CommandStorage | null,
  storageKey: string,
  expected: ShippingOneOffRetainedCommand | null,
  replacement: ShippingOneOffRetainedCommand | null,
) {
  if (!storage) return false
  try {
    const raw = storage.getItem(storageKey)
    const current = raw === null
      ? null
      : JSON.parse(raw) as ShippingOneOffRetainedCommand | null
    if (!shippingOneOffRetainedCommandsMatch(current, expected)) return false
    if (replacement) storage.setItem(storageKey, JSON.stringify(replacement))
    else storage.removeItem(storageKey)
    return true
  } catch {
    return false
  }
}

export function shippingOneOffResponseIsDefinitiveClientRejection(
  status: number,
  malformed: boolean,
) {
  return !malformed
    && status >= 400
    && status < 500
    && status !== 408
    && status !== 425
    && status !== 429
}
