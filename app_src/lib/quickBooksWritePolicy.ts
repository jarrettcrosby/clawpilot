import type { QuickBooksWriteOperationKind } from '@/lib/integrations/quickBooksWritePayloads'

export type QuickBooksWriteMode = 'sandbox' | 'production'

export type QuickBooksWritePolicy = {
  enabled: boolean
  mode: QuickBooksWriteMode | null
  allowedOperations: QuickBooksWriteOperationKind[]
}
const supportedOperations = new Set<QuickBooksWriteOperationKind>([
  'customer.create',
  'item.create',
  'invoice.create',
  'sales_receipt.create',
  'journal_entry.create',
])

export function configuredQuickBooksWritePolicy(
  environment: Record<string, string | undefined> = process.env,
): QuickBooksWritePolicy {
  const rawMode = String(environment.QUICKBOOKS_WRITE_MODE || '').trim()
  const mode = rawMode === 'sandbox' || rawMode === 'production' ? rawMode : null
  const allowedOperations = [...new Set(
    String(environment.QUICKBOOKS_WRITE_OPERATIONS || '')
      .split(',')
      .map((value) => value.trim())
      .filter((value): value is QuickBooksWriteOperationKind => supportedOperations.has(value as QuickBooksWriteOperationKind)),
  )]
  return {
    enabled: environment.QUICKBOOKS_WRITES_ENABLED === '1' && Boolean(mode) && allowedOperations.length > 0,
    mode,
    allowedOperations,
  }
}
