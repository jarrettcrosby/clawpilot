export const SHOPIFY_INVENTORY_STATE_NAMES = Object.freeze([
  'available',
  'incoming',
  'committed',
  'damaged',
  'on_hand',
  'quality_control',
  'reserved',
  'safety_stock',
] as const)

export type ShopifyInventoryStateName =
  (typeof SHOPIFY_INVENTORY_STATE_NAMES)[number]

export type ShopifyInventoryQuantities = Record<
  ShopifyInventoryStateName,
  number
>

export type ShopifyInventoryProjectionState =
  | 'projected'
  | 'unmapped'
  | 'untracked'
  | 'inconsistent'
  | 'negative_available'

export function shopifyPhysicalStateTotal(
  quantities: ShopifyInventoryQuantities,
) {
  return quantities.available
    + quantities.committed
    + quantities.reserved
    + quantities.damaged
    + quantities.safety_stock
    + quantities.quality_control
}

export function shopifyInventoryEquationMatches(
  quantities: ShopifyInventoryQuantities,
) {
  return quantities.on_hand === shopifyPhysicalStateTotal(quantities)
}

function protectedStateIsNegative(
  quantities: ShopifyInventoryQuantities,
) {
  return quantities.incoming < 0
    || quantities.committed < 0
    || quantities.damaged < 0
    || quantities.on_hand < 0
    || quantities.quality_control < 0
    || quantities.reserved < 0
    || quantities.safety_stock < 0
}

export function projectShopifyInventoryBalance(input: {
  mapped: boolean
  tracked: boolean
  quantities: ShopifyInventoryQuantities
}) {
  const equationMatches = shopifyInventoryEquationMatches(input.quantities)
  let state: ShopifyInventoryProjectionState
  if (!input.mapped) state = 'unmapped'
  else if (!input.tracked) state = 'untracked'
  else if (input.quantities.available < 0) state = 'negative_available'
  else if (
    !equationMatches
    || protectedStateIsNegative(input.quantities)
  ) state = 'inconsistent'
  else state = 'projected'

  const sourceAvailable = Math.max(0, input.quantities.available)
  const sourceCommitted = Math.max(0, input.quantities.committed)
  const projected = state === 'projected'

  return Object.freeze({
    state,
    equationMatches,
    sourceAvailable,
    sourceCommitted,
    operationalOnHand: projected
      ? sourceAvailable + sourceCommitted
      : 0,
    operationalReserved: projected ? sourceCommitted : 0,
    operationalAvailable: projected ? sourceAvailable : 0,
  })
}
