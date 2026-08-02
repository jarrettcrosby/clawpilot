import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import type { SuiteCrmOutboxRecord } from '@/lib/crm/types'
import {
  withTransaction,
} from '@/lib/persistence/postgres'

type ProductProjectionRow = QueryResultRow & {
  organization_id: string
  pipeline_id: string
  product_id: string
  suitecrm_id: string | null
  reference_code: string
  name: string
  sku: string | null
  product_type: string | null
  category: string | null
  cost: string | number | null
  price: string | number | null
  currency: string | null
  url: string | null
  description: string | null
  image_asset_id: string | null
  image_asset_revision: string | number | null
  image_row_version: string | number | null
  image_content_sha256: string | null
}

export type SuiteCrmProductImageProjectionEnqueueResult = {
  queued: boolean
  idempotencyKey: string | null
  productId: string
  productReferenceCode: string
  suiteCrmId: string | null
  imageAssetId: string | null
  contentSha256: string | null
}

function finiteMoney(value: string | number | null) {
  const parsed = Number(value || 0)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('CRM Product image projection money is invalid')
  }
  return parsed
}

function positiveInteger(value: string | number | null, label: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`CRM Product image projection ${label} is invalid`)
  }
  return parsed
}

export async function enqueueSuiteCrmProductImageProjectionWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    pipelineId: string
    productId: string
    actorEmail: string
  },
): Promise<SuiteCrmProductImageProjectionEnqueueResult> {
  const selected = await client.query<ProductProjectionRow>(
    `SELECT
       pipeline.workspace_organization_id::text AS organization_id,
       product.pipeline_id::text,
       product.id::text AS product_id,
       product.suitecrm_id,
       product.reference_code,
       product.name,
       product.sku,
       product.product_type,
       product.category,
       product.cost::text,
       product.price::text,
       product.currency,
       product.url,
       product.description,
       image_asset.id::text AS image_asset_id,
       image_asset.asset_revision::text AS image_asset_revision,
       image_asset.row_version::text AS image_row_version,
       image_asset.content_sha256 AS image_content_sha256
     FROM crm_products product
     JOIN pipeline_spaces pipeline
       ON pipeline.id = product.pipeline_id
      AND pipeline.workspace_organization_id = $1::uuid
     LEFT JOIN LATERAL (
       SELECT asset.id, asset.asset_revision, asset.row_version,
         asset.content_sha256
       FROM crm_product_image_assets asset
       WHERE asset.organization_id = pipeline.workspace_organization_id
         AND asset.pipeline_id = product.pipeline_id
         AND asset.product_id = product.id
         AND asset.is_primary = true
       ORDER BY asset.asset_revision, asset.id
       LIMIT 1
     ) image_asset ON true
     WHERE product.pipeline_id = $2::uuid
       AND product.id = $3::uuid
     LIMIT 1
     FOR SHARE OF product`,
    [input.organizationId, input.pipelineId, input.productId],
  )
  const row = selected.rows[0]
  if (!row) throw new Error('CRM Product image projection Product was not found')
  if (row.organization_id !== input.organizationId) {
    throw new Error('CRM Product image projection organization changed')
  }
  const baseResult = {
    productId: row.product_id,
    productReferenceCode: row.reference_code,
    suiteCrmId: row.suitecrm_id,
    imageAssetId: row.image_asset_id,
    contentSha256: row.image_content_sha256,
  }
  if (!row.suitecrm_id) {
    return { ...baseResult, queued: false, idempotencyKey: null }
  }
  if ((row.image_asset_id === null) !== (row.image_content_sha256 === null)) {
    throw new Error('CRM Product image projection evidence is incomplete')
  }
  const imageFence = row.image_asset_id
    ? `${row.image_asset_id}:${positiveInteger(
      row.image_asset_revision,
      'asset revision',
    )}:${positiveInteger(row.image_row_version, 'asset row version')}:${
      row.image_content_sha256
    }`
    : 'none'
  const idempotencyKey = `crm:products:image:v1:${row.product_id}:${imageFence}`
  const payload: SuiteCrmOutboxRecord = {
    entity: 'products',
    pipelineId: row.pipeline_id,
    localId: row.product_id,
    suiteCrmId: row.suitecrm_id,
    attributes: {
      global_id_c: row.reference_code,
      name: String(row.name || '').trim(),
      part_number: String(row.sku || '').trim(),
      type: String(row.product_type || '').trim() || 'Good',
      category: String(row.category || '').trim(),
      cost: finiteMoney(row.cost),
      price: finiteMoney(row.price),
      url: String(row.url || '').trim(),
      description: String(row.description || '').trim(),
    },
    currencyCode: String(row.currency || 'USD').trim().toUpperCase(),
    productImage: row.image_asset_id && row.image_content_sha256
      ? {
        referenceCode: row.reference_code,
        contentSha256: row.image_content_sha256,
      }
      : null,
  }
  const queued = await client.query<{ idempotency_key: string }>(
    `INSERT INTO sync_outbox (
       aggregate_type, aggregate_id, operation, target_system, payload,
       status, idempotency_key, created_at, available_at, updated_at
     ) VALUES (
       'crm_products', $1::uuid, 'upsert_record', 'suitecrm', $2::jsonb,
       'queued', $3, now(), now(), now()
     )
     ON CONFLICT (target_system, idempotency_key)
     WHERE idempotency_key IS NOT NULL
     DO UPDATE SET
       payload = EXCLUDED.payload,
       status = 'queued',
       attempts = 0,
       last_error = NULL,
       available_at = now(),
       processed_at = NULL,
       locked_at = NULL,
       lock_token = NULL,
       updated_at = now()
     WHERE sync_outbox.status IN ('succeeded', 'dead')
     RETURNING idempotency_key`,
    [row.product_id, JSON.stringify(payload), idempotencyKey],
  )
  const wasQueued = Boolean(queued.rows[0])
  if (wasQueued) {
    await client.query(
      `UPDATE crm_products
       SET sync_status = 'pending', sync_error = NULL, updated_at = now()
       WHERE pipeline_id = $1::uuid AND id = $2::uuid`,
      [row.pipeline_id, row.product_id],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'crm.product_image.suitecrm_queued',
      aggregateType: 'crm_product',
      aggregateId: row.product_id,
      organizationId: input.organizationId,
      eventKey: `crm-product-image-suitecrm:${idempotencyKey}`,
      payload: {
        pipelineId: row.pipeline_id,
        productId: row.product_id,
        productReferenceCode: row.reference_code,
        suiteCrmId: row.suitecrm_id,
        imageAssetId: row.image_asset_id,
        imageContentSha256: row.image_content_sha256,
        projection: row.image_asset_id ? 'set' : 'clear',
      },
    }, client)
  }
  return {
    ...baseResult,
    queued: wasQueued,
    idempotencyKey,
  }
}

export async function enqueueSuiteCrmProductImageProjectionInPostgres(input: {
  organizationId: string
  pipelineId: string
  productId: string
  actorEmail: string
}) {
  return withTransaction((client) => (
    enqueueSuiteCrmProductImageProjectionWithClient(client, input)
  ))
}
