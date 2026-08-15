import { createHash } from 'node:crypto'

const RECEIPT_GLOBAL_ID = /^gsqr(?:[0-9]{7}|[0-9a-v]{12})$/
const CARRIER_ACCOUNT_GLOBAL_ID = /^gac(?:[0-9]{7}|[0-9a-v]{12})$/

/**
 * Binds immutable carrier evidence to one checkout receipt and one exact
 * billing account. The database independently derives the same key before it
 * accepts a provider attempt, so concurrent identical checkouts cannot reuse
 * each other's rate evidence.
 */
export function shopifyCheckoutCarrierSelectionKey(input: {
  receiptGlobalId: string
  carrierAccountGlobalId: string
}) {
  if (!RECEIPT_GLOBAL_ID.test(input.receiptGlobalId)) {
    throw new Error('Shopify checkout receipt Global ID is invalid')
  }
  if (!CARRIER_ACCOUNT_GLOBAL_ID.test(input.carrierAccountGlobalId)) {
    throw new Error('Carrier account Global ID is invalid')
  }
  return createHash('sha256')
    .update(
      `shopify-checkout-carrier-selection-v1|${
        input.receiptGlobalId
      }|${input.carrierAccountGlobalId}`,
    )
    .digest('hex')
}
