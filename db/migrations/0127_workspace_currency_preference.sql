-- Currency is an organization accounting/display default. Provider-owned and
-- record-owned money keeps its stored ISO 4217 currency and is never relabeled
-- or converted by this preference.

ALTER TABLE workspace_organization_preferences
  ADD COLUMN IF NOT EXISTS currency_code text;

UPDATE workspace_organization_preferences
SET currency_code = 'USD'
WHERE currency_code IS NULL;

ALTER TABLE workspace_organization_preferences
  ALTER COLUMN currency_code SET DEFAULT 'USD',
  ALTER COLUMN currency_code SET NOT NULL;

ALTER TABLE workspace_organization_preferences
  DROP CONSTRAINT IF EXISTS workspace_organization_preferences_currency_code_valid,
  ADD CONSTRAINT workspace_organization_preferences_currency_code_valid
    CHECK (currency_code ~ '^[A-Z]{3}$');

-- Existing SuiteCRM products were projected without currency_id. Requeue the
-- current canonical product facts so the application worker can resolve the
-- stored ISO code to SuiteCRM's native currency identity. No amount or source
-- currency changes here.
WITH queued AS (
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
    product.id::text,
    'upsert_record',
    'suitecrm',
    jsonb_build_object(
      'entity', 'products',
      'pipelineId', product.pipeline_id::text,
      'localId', product.id::text,
      'suiteCrmId', product.suitecrm_id,
      'currencyCode', upper(product.currency),
      'attributes', jsonb_build_object(
        'global_id_c', product.reference_code,
        'name', product.name,
        'part_number', COALESCE(product.sku, ''),
        'type', COALESCE(NULLIF(product.product_type, ''), 'Good'),
        'category', COALESCE(product.category, ''),
        'cost', product.cost,
        'price', product.price,
        'url', COALESCE(product.url, ''),
        'description', COALESCE(product.description, '')
      )
    ),
    'queued',
    'crm:products:currency-projection:v1:' || product.id::text
      || ':' || product.source_hash,
    now(),
    now(),
    now()
  FROM crm_products product
  WHERE NULLIF(btrim(product.suitecrm_id), '') IS NOT NULL
    AND upper(product.currency) ~ '^[A-Z]{3}$'
  ON CONFLICT (target_system, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING aggregate_id
)
UPDATE crm_products product
SET sync_status = 'pending',
    sync_error = NULL,
    updated_at = now()
FROM queued
WHERE product.id::text = queued.aggregate_id;
