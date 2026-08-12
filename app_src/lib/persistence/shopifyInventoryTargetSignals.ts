import type { PoolClient } from 'pg'
import type {
  ShopifyInventoryWebhookTargeting,
} from '@/lib/integrations/shopifyInventoryWebhook'

/**
 * Persists shadow-only targetability evidence inside the caller's signed
 * receipt transaction. The existing full inventory refresh remains the only
 * executable reconciliation path.
 */
export async function recordShopifyInventoryTargetSignalWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    credentialGeneration: number
    receiptId: string
    receiptGlobalId: string
    dirtyVersion: number
    topic: string
    targeting: ShopifyInventoryWebhookTargeting
  },
) {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO operations_shopify_inventory_target_signals (
       organization_id,
       integration_account_id,
       credential_generation,
       receipt_id,
       receipt_global_id,
       dirty_version,
       topic,
       inventory_item_gid,
       source_location_gid,
       targeting_state,
       reason_code,
       provider_triggered_at,
       received_at,
       created_by
     )
     SELECT
       $1::uuid,
       $2::uuid,
       $3::integer,
       $4::uuid,
       $5,
       $6::bigint,
       $7,
       $8,
       $9,
       $10,
       $11,
       receipt.provider_triggered_at,
       receipt.received_at,
       'system'
     FROM operations_commerce_webhook_receipts receipt
     WHERE receipt.organization_id = $1::uuid
       AND receipt.integration_account_id = $2::uuid
       AND receipt.id = $4::uuid
       AND receipt.global_id = $5
     RETURNING id::text`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.credentialGeneration,
      input.receiptId,
      input.receiptGlobalId,
      input.dirtyVersion,
      input.topic,
      input.targeting.inventoryItemGid,
      input.targeting.sourceLocationGid,
      input.targeting.targetingState,
      input.targeting.reasonCode,
    ],
  )
  if (!inserted.rows[0]) {
    throw new Error('Shopify inventory target signal was not recorded')
  }
  return { id: inserted.rows[0].id }
}
