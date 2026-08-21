import { query } from '@/lib/persistence/postgres'

export type CommerceAccountDiscoveryItem = {
  accountGlobalId: string
  provider: 'shopify' | 'faire'
  environment: 'mock' | 'sandbox' | 'production'
  displayName: string
  status: 'active' | 'disabled' | 'error'
}

type CommerceAccountDiscoveryRow = {
  account_global_id: string
  provider: CommerceAccountDiscoveryItem['provider']
  environment: CommerceAccountDiscoveryItem['environment']
  display_name: string
  status: CommerceAccountDiscoveryItem['status']
}

export async function readCommerceAccountDiscoveryFromPostgres(
  organizationId: string,
): Promise<CommerceAccountDiscoveryItem[]> {
  const result = await query<CommerceAccountDiscoveryRow>(
    `SELECT
       account.global_id AS account_global_id,
       account.provider,
       account.environment,
       account.display_name,
       account.status
     FROM operations_integration_accounts account
     WHERE account.organization_id = $1::uuid
       AND account.integration_type = 'commerce'
       AND account.provider IN ('shopify', 'faire')
     ORDER BY lower(account.display_name), account.global_id`,
    [organizationId],
  )
  return result.rows.map((row) => ({
    accountGlobalId: row.account_global_id,
    provider: row.provider,
    environment: row.environment,
    displayName: row.display_name,
    status: row.status,
  }))
}
