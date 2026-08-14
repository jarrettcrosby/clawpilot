export function commerceOrderQuantitySummary(input: {
  orderedQuantity: number
  fulfilledQuantity: number | null
}) {
  const fulfillment = input.fulfilledQuantity === null
    ? 'fulfillment unavailable'
    : `${input.fulfilledQuantity} fulfilled`
  return `${input.orderedQuantity} ordered · ${fulfillment}`
}
