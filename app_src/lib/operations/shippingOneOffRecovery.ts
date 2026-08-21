export type ShippingOneOffCommandAction = 'pack' | 'packed-rate' | 'purchase' | 'void'

export type ShippingOneOffRetainedCommand = {
  key: string
  body: string
}

type CommandStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function expectedBodyAction(action: ShippingOneOffCommandAction) {
  if (action === 'pack') return 'confirm-pack'
  if (action === 'packed-rate') return 'refresh-packed-rates'
  if (action === 'purchase') return 'purchase-group'
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
        return { key: parsed.key, body: parsed.body }
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
