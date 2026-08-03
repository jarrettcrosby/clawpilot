export type CommerceProviderUnitPrice = Readonly<{
  amountMinor: bigint
  currency: string
}>

export type CommerceOrderLinePriceResolution = Readonly<{
  state: 'provider' | 'unresolved'
  resolvedCurrencyCode: string | null
  resolvedUnitPriceMinor: bigint | null
  requiresOperatorResolution: boolean
}>

export type CommerceOrderLineProviderMoney = Readonly<{
  currencyCode: string | null
  unitPriceMinor: bigint | null
  subtotalMinor: bigint | null
  discountMinor: bigint | null
  taxMinor: bigint | null
}>

/**
 * PostgreSQL returns NUMERIC(20,6) quantities with their declared scale (for
 * example, `50.000000`). Commerce order demand is still whole sell units, so
 * accept only canonical nonnegative integers with the table's exact six-zero
 * fractional suffix. A real fractional quantity, unexpected scale, exponent,
 * sign, whitespace, or other malformed value remains unavailable and must fail
 * closed before promotion.
 */
export function exactWholeCommerceQuantityFromNumeric(value: string) {
  const match = /^(0|[1-9][0-9]*)(?:\.0{6})?$/.exec(value)
  return match ? BigInt(match[1]) : null
}

/**
 * The intake table stores one coherent, nonnegative provider-money currency
 * per line. Retain every compatible source amount, but represent invalid or
 * mixed-currency fields as unavailable so repairable provider evidence cannot
 * violate the database constraint and roll back the entire intake batch.
 */
export function storableCommerceOrderLineProviderMoney(input: Readonly<{
  unitPrice: CommerceProviderUnitPrice | null
  subtotal: CommerceProviderUnitPrice | null
  discount: CommerceProviderUnitPrice | null
  tax: CommerceProviderUnitPrice | null
}>): CommerceOrderLineProviderMoney {
  const currencyCode = (
    input.unitPrice
    || input.subtotal
    || input.discount
    || input.tax
  )?.currency || null
  const storableAmount = (value: CommerceProviderUnitPrice | null) => (
    value !== null
    && value.currency === currencyCode
    && value.amountMinor >= BigInt(0)
  ) ? value.amountMinor : null

  return Object.freeze({
    currencyCode,
    unitPriceMinor: storableAmount(input.unitPrice),
    subtotalMinor: storableAmount(input.subtotal),
    discountMinor: storableAmount(input.discount),
    taxMinor: storableAmount(input.tax),
  })
}

/**
 * Treat exact provider order-time money as immutable source authority.
 * Missing, negative, or cross-currency money remains unresolved rather than
 * borrowing a mutable CRM Product price or relabeling another currency.
 */
export function resolveCommerceOrderLineProviderPrice(input: Readonly<{
  orderCurrency: string
  unitPrice: CommerceProviderUnitPrice | null
  unfulfilledQuantity: number
}>): CommerceOrderLinePriceResolution {
  const hasFulfillmentDemand = input.unfulfilledQuantity > 0
  const exactProviderPrice = (
    hasFulfillmentDemand
    && input.unitPrice !== null
    && input.unitPrice.amountMinor >= BigInt(0)
    && input.unitPrice.currency === input.orderCurrency
  )

  return Object.freeze(exactProviderPrice
    ? {
        state: 'provider' as const,
        resolvedCurrencyCode: input.unitPrice?.currency || null,
        resolvedUnitPriceMinor: input.unitPrice?.amountMinor ?? null,
        requiresOperatorResolution: false,
      }
    : {
        state: 'unresolved' as const,
        resolvedCurrencyCode: null,
        resolvedUnitPriceMinor: null,
        requiresOperatorResolution: hasFulfillmentDemand,
      })
}
