-- Queue the existing ClawPilot-selected primary Product images for SuiteCRM.
-- Runtime hooks added with this migration's application release keep later
-- primary selections synchronized; this backfill closes the pre-release gap.

WITH eligible AS (
  SELECT
    product.id,
    product.pipeline_id,
    product.suitecrm_id,
    product.reference_code,
    product.name,
    product.sku,
    product.product_type,
    product.category,
    product.cost,
    product.price,
    product.currency,
    product.url,
    product.description,
    product.updated_by,
    asset.id AS asset_id,
    asset.asset_revision,
    asset.row_version AS asset_row_version,
    asset.content_sha256,
    'crm:products:image:v1:' || product.id::text || ':'
      || asset.id::text || ':' || asset.asset_revision::text || ':'
      || asset.row_version::text || ':' || asset.content_sha256
      AS idempotency_key
  FROM crm_products product
  JOIN pipeline_spaces pipeline ON pipeline.id = product.pipeline_id
  LEFT JOIN workspace_organizations organization
    ON organization.id = pipeline.workspace_organization_id
  JOIN crm_product_image_assets asset
    ON asset.pipeline_id = product.pipeline_id
   AND asset.product_id = product.id
   AND asset.is_primary = true
  WHERE product.suitecrm_id IS NOT NULL
    AND COALESCE(organization.is_demo, false) = false
), queued AS (
  INSERT INTO sync_outbox (
    aggregate_type,
    aggregate_id,
    operation,
    target_system,
    payload,
    status,
    idempotency_key,
    created_at,
    available_at,
    updated_at
  )
  SELECT
    'crm_products',
    eligible.id::text,
    'upsert_record',
    'suitecrm',
    jsonb_build_object(
      'entity', 'products',
      'pipelineId', eligible.pipeline_id::text,
      'localId', eligible.id::text,
      'suiteCrmId', eligible.suitecrm_id,
      'attributes', jsonb_build_object(
        'global_id_c', eligible.reference_code,
        'name', btrim(eligible.name),
        'part_number', COALESCE(btrim(eligible.sku), ''),
        'type', COALESCE(NULLIF(btrim(eligible.product_type), ''), 'Good'),
        'category', COALESCE(btrim(eligible.category), ''),
        'cost', COALESCE(eligible.cost, 0),
        'price', COALESCE(eligible.price, 0),
        'url', COALESCE(btrim(eligible.url), ''),
        'description', COALESCE(btrim(eligible.description), '')
      ),
      'currencyCode', upper(
        COALESCE(NULLIF(btrim(eligible.currency), ''), 'USD')
      ),
      'productImage', jsonb_build_object(
        'referenceCode', eligible.reference_code,
        'contentSha256', eligible.content_sha256
      )
    ),
    'queued',
    eligible.idempotency_key,
    now(),
    now(),
    now()
  FROM eligible
  ON CONFLICT (target_system, idempotency_key)
  WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING aggregate_id, idempotency_key
)
UPDATE crm_products product
SET sync_status = 'pending',
    sync_error = NULL,
    updated_at = now()
FROM queued
WHERE product.id::text = queued.aggregate_id;

INSERT INTO audit_events (
  actor,
  event_type,
  aggregate_type,
  aggregate_id,
  payload,
  event_key,
  created_at
)
SELECT
  product.updated_by,
  'crm.product_image.suitecrm_backfill_queued',
  'crm_product',
  product.id::text,
  jsonb_build_object(
    'pipelineId', product.pipeline_id::text,
    'productId', product.id::text,
    'productReferenceCode', product.reference_code,
    'suiteCrmId', product.suitecrm_id,
    'imageAssetId', asset.id::text,
    'imageContentSha256', asset.content_sha256,
    'projection', 'set'
  ),
  'crm-product-image-suitecrm-backfill:' || product.id::text || ':'
    || asset.id::text || ':' || asset.asset_revision::text || ':'
    || asset.row_version::text || ':' || asset.content_sha256,
  now()
FROM crm_products product
JOIN pipeline_spaces pipeline ON pipeline.id = product.pipeline_id
LEFT JOIN workspace_organizations organization
  ON organization.id = pipeline.workspace_organization_id
JOIN crm_product_image_assets asset
  ON asset.pipeline_id = product.pipeline_id
 AND asset.product_id = product.id
 AND asset.is_primary = true
WHERE product.suitecrm_id IS NOT NULL
  AND COALESCE(organization.is_demo, false) = false
ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING;
