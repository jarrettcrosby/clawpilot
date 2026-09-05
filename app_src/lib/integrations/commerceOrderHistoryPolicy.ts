import type { CommerceProvider } from '@/lib/integrations/commerceCredentialCrypto'

export const COMMERCE_ORDER_HISTORY_MODES = [
  'new_orders_only',
  'last_7_days',
  'last_30_days',
  'last_60_days',
  'provider_all',
] as const

export type CommerceOrderHistoryMode =
  (typeof COMMERCE_ORDER_HISTORY_MODES)[number]

export function normalizeCommerceOrderHistoryMode(
  value: unknown,
  provider: CommerceProvider,
): CommerceOrderHistoryMode {
  const fallback: CommerceOrderHistoryMode = 'new_orders_only'
  const mode = value === undefined || value === null || value === ''
    ? fallback
    : String(value).trim()
  if (
    !COMMERCE_ORDER_HISTORY_MODES.includes(
      mode as CommerceOrderHistoryMode,
    )
    || (provider === 'shopify' && mode === 'provider_all')
  ) {
    throw new Error(
      `Commerce order history selection is invalid for ${provider}`,
    )
  }
  return mode as CommerceOrderHistoryMode
}

export function commerceOrderHistoryRequestedFrom(
  mode: CommerceOrderHistoryMode,
  frozenAt: Date,
) {
  if (mode === 'provider_all') return null
  const days = mode === 'last_7_days'
    ? 7
    : mode === 'last_30_days'
      ? 30
      : mode === 'last_60_days'
        ? 60
        : 0
  return new Date(frozenAt.getTime() - days * 24 * 60 * 60 * 1_000)
}

export function commerceOrderHistoryCoverageBasis(
  provider: CommerceProvider,
  mode: CommerceOrderHistoryMode,
) {
  if (provider === 'faire' && mode === 'provider_all') {
    return 'faire_provider_available_orders' as const
  }
  return provider === 'shopify'
    ? 'shopify_configured_history_window' as const
    : 'faire_configured_history_window' as const
}

export function commerceOrderHistoryCompletionMeaning(input: {
  provider: CommerceProvider
  mode: CommerceOrderHistoryMode
  readAllOrdersGranted?: boolean
}) {
  if (input.provider === 'faire') {
    return input.mode === 'provider_all'
      ? 'faire_provider_available_orders_complete' as const
      : 'faire_configured_window_orders_complete' as const
  }
  return input.readAllOrdersGranted
    ? 'shopify_configured_window_orders_complete' as const
    : 'shopify_configured_window_read_attempt_complete' as const
}
