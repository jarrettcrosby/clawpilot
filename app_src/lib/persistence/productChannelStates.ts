import type { PoolClient } from 'pg'
import type {
  CommerceProductChannelStatus,
} from '@/lib/integrations/commerceProductLifecycle'
import type {
  ProductSalesChannelState,
} from '@/lib/crm/types'
import { query } from '@/lib/persistence/postgres'

export type ProductChannelStateObservation = {
  organizationId: string
  integrationAccountId: string
  pipelineId: string
  provider: 'shopify' | 'faire'
  externalProductId: string
  externalVariantId: string
  externalInventoryItemId: string | null
  productId: string | null
  productMappingId: string | null
  providerStatusRaw: string
  normalizedStatus: CommerceProductChannelStatus
  providerActive: boolean | null
  providerUpdatedAt: string | null
  observedAt: string
  sourceRevision: string
  sourceHash: string
  actorEmail: string
}

export async function upsertProductChannelStateWithClient(
  client: PoolClient,
  input: ProductChannelStateObservation,
) {
  await client.query(
    `INSERT INTO operations_product_channel_states (
       organization_id, integration_account_id, pipeline_id, provider,
       external_product_id, external_variant_id, external_inventory_item_id,
       product_id, product_mapping_id, provider_status_raw,
       normalized_status, provider_active, provider_updated_at, observed_at,
       source_revision, source_hash, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
       $8::uuid, $9::uuid, $10, $11, $12, $13::timestamptz,
       $14::timestamptz, $15, $16, $17, $17
     )
     ON CONFLICT (
       organization_id, integration_account_id, external_variant_id
     ) DO UPDATE SET
       provider = EXCLUDED.provider,
       external_product_id = EXCLUDED.external_product_id,
       external_inventory_item_id = EXCLUDED.external_inventory_item_id,
       provider_status_raw = EXCLUDED.provider_status_raw,
       normalized_status = EXCLUDED.normalized_status,
       provider_active = EXCLUDED.provider_active,
       provider_updated_at = EXCLUDED.provider_updated_at,
       observed_at = EXCLUDED.observed_at,
       source_revision = EXCLUDED.source_revision,
       source_hash = EXCLUDED.source_hash,
       product_id = COALESCE(
         EXCLUDED.product_id,
         operations_product_channel_states.product_id
       ),
       product_mapping_id = COALESCE(
         EXCLUDED.product_mapping_id,
         operations_product_channel_states.product_mapping_id
       ),
       row_version = operations_product_channel_states.row_version + 1,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     WHERE COALESCE(
       EXCLUDED.provider_updated_at,
       EXCLUDED.observed_at
     ) >= COALESCE(
       operations_product_channel_states.provider_updated_at,
       operations_product_channel_states.observed_at
     )`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.pipelineId,
      input.provider,
      input.externalProductId,
      input.externalVariantId,
      input.externalInventoryItemId,
      input.productId,
      input.productMappingId,
      input.providerStatusRaw,
      input.normalizedStatus,
      input.providerActive,
      input.providerUpdatedAt,
      input.observedAt,
      input.sourceRevision,
      input.sourceHash,
      input.actorEmail,
    ],
  )
}

export async function linkProductChannelStateWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    pipelineId: string
    externalVariantId: string
    productId: string
    productMappingId: string
    actorEmail: string
  },
) {
  await client.query(
    `UPDATE operations_product_channel_states
     SET product_id = $5::uuid,
         product_mapping_id = $6::uuid,
         row_version = row_version + 1,
         updated_by = $7,
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND pipeline_id = $3::uuid
       AND external_variant_id = $4`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.pipelineId,
      input.externalVariantId,
      input.productId,
      input.productMappingId,
      input.actorEmail,
    ],
  )
}

export async function readProductChannelStatesInPostgres(input: {
  pipelineId: string
  productIds: string[]
}) {
  if (input.productIds.length === 0) {
    return new Map<string, ProductSalesChannelState[]>()
  }
  const result = await query<Record<string, unknown>>(
    `SELECT
       state.id::text,
       state.global_id,
       state.organization_id::text,
       state.integration_account_id::text,
       account.global_id AS integration_account_global_id,
       account.display_name AS integration_account_name,
       account.status AS integration_account_status,
       account.environment,
       state.pipeline_id::text,
       state.provider,
       state.external_product_id,
       state.external_variant_id,
       state.external_inventory_item_id,
       state.product_id::text,
       state.product_mapping_id::text,
       mapping.global_id AS product_mapping_global_id,
       state.provider_status_raw,
       state.normalized_status,
       state.provider_active,
       state.provider_updated_at::text,
       state.observed_at::text,
       state.source_revision,
       state.row_version::text
     FROM operations_product_channel_states AS state
     JOIN operations_integration_accounts AS account
       ON account.organization_id = state.organization_id
      AND account.id = state.integration_account_id
     LEFT JOIN operations_product_mappings AS mapping
       ON mapping.organization_id = state.organization_id
      AND mapping.integration_account_id = state.integration_account_id
      AND mapping.pipeline_id = state.pipeline_id
      AND mapping.id = state.product_mapping_id
      AND mapping.product_id = state.product_id
     WHERE state.pipeline_id = $1::uuid
       AND state.product_id = ANY($2::uuid[])
     ORDER BY
       state.product_id,
       state.provider,
       lower(account.display_name),
       state.external_variant_id`,
    [input.pipelineId, input.productIds],
  )
  const byProduct = new Map<string, ProductSalesChannelState[]>()
  for (const row of result.rows) {
    const productId = String(row.product_id)
    const states = byProduct.get(productId) || []
    states.push({
      id: String(row.id),
      globalId: String(row.global_id),
      organizationId: String(row.organization_id),
      integrationAccountId: String(row.integration_account_id),
      integrationAccountGlobalId: String(
        row.integration_account_global_id,
      ),
      integrationAccountName: String(row.integration_account_name),
      integrationAccountStatus:
        row.integration_account_status as ProductSalesChannelState[
          'integrationAccountStatus'
        ],
      environment:
        row.environment as ProductSalesChannelState['environment'],
      pipelineId: String(row.pipeline_id),
      provider: row.provider as ProductSalesChannelState['provider'],
      externalProductId: String(row.external_product_id),
      externalVariantId: String(row.external_variant_id),
      externalInventoryItemId: row.external_inventory_item_id
        ? String(row.external_inventory_item_id)
        : null,
      productId,
      productMappingId: row.product_mapping_id
        ? String(row.product_mapping_id)
        : null,
      productMappingGlobalId: row.product_mapping_global_id
        ? String(row.product_mapping_global_id)
        : null,
      providerStatusRaw: String(row.provider_status_raw),
      normalizedStatus:
        row.normalized_status as ProductSalesChannelState[
          'normalizedStatus'
        ],
      providerActive: typeof row.provider_active === 'boolean'
        ? row.provider_active
        : null,
      providerUpdatedAt: row.provider_updated_at
        ? String(row.provider_updated_at)
        : null,
      observedAt: String(row.observed_at),
      sourceRevision: String(row.source_revision),
      rowVersion: Number(row.row_version),
    })
    byProduct.set(productId, states)
  }
  return byProduct
}
