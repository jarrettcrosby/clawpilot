-- The legacy workbook stores a selected product array as a comma-separated cell.
-- Migration 0045 treated every observed combination as a durable product. Keep
-- the atomic generated products and permanently retire only generated combos.
CREATE TEMP TABLE generated_product_combinations ON COMMIT DROP AS
SELECT
  product.id,
  product.pipeline_id,
  product.suitecrm_id,
  product.reference_code,
  product.name
FROM crm_products product
WHERE product.source_payload->>'source' = 'clawpilot_pipeline_catalog_bootstrap'
  AND (
    product.name LIKE '%,%'
    OR (
      lower(product.name) IN ('open', 'on hold', 'closed', 'won', 'lost', 'abandoned')
      AND EXISTS (
        SELECT 1
        FROM pipeline_dropdown_catalogs catalog
        WHERE catalog.pipeline_id = product.pipeline_id
          AND jsonb_typeof(catalog.catalog->'dropdowns'->'status') = 'array'
          AND jsonb_typeof(catalog.catalog->'dropdowns'->'loss_reason') = 'array'
          AND jsonb_typeof(catalog.catalog->'dropdowns'->'interaction') = 'array'
          AND jsonb_typeof(catalog.catalog->'dropdowns'->'acct_manager') = 'array'
          AND jsonb_typeof(catalog.catalog->'dropdowns'->'source') = 'array'
          AND jsonb_typeof(catalog.catalog->'dropdowns'->'product') = 'array'
          AND COALESCE(catalog.catalog->'dropdowns'->'source'->0->>'value', '')
            = COALESCE(catalog.catalog->'dropdowns'->'product'->0->>'value', '')
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'status') option
            WHERE lower(COALESCE(option->>'label', option->>'value', '')) = 'identified lead'
          )
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'loss_reason') option
            WHERE upper(COALESCE(option->>'label', option->>'value', '')) = 'A+'
          )
      )
    )
  );

DELETE FROM crm_opportunity_products relationship
USING generated_product_combinations combination
WHERE relationship.pipeline_id = combination.pipeline_id
  AND relationship.product_id = combination.id;

DELETE FROM sync_outbox outbox
USING generated_product_combinations combination
WHERE outbox.target_system = 'suitecrm'
  AND outbox.aggregate_type = 'crm_products'
  AND outbox.aggregate_id = combination.id::text;

INSERT INTO sync_outbox (
  aggregate_type,
  aggregate_id,
  operation,
  target_system,
  payload,
  status,
  attempts,
  idempotency_key,
  created_at,
  available_at,
  updated_at
)
SELECT
  'crm_products',
  combination.id::text,
  'delete_record',
  'suitecrm',
  jsonb_build_object(
    'entity', 'products',
    'pipelineId', combination.pipeline_id::text,
    'localId', combination.id::text,
    'suiteCrmId', combination.suitecrm_id,
    'attributes', '{}'::jsonb
  ),
  'queued',
  0,
  'crm:products:combination-cleanup:v1:' || combination.id::text,
  now(),
  now(),
  now()
FROM generated_product_combinations combination
WHERE NULLIF(btrim(combination.suitecrm_id), '') IS NOT NULL
ON CONFLICT (target_system, idempotency_key)
WHERE idempotency_key IS NOT NULL
DO NOTHING;

DELETE FROM crm_products product
USING generated_product_combinations combination
WHERE product.id = combination.id;

-- Retain the allocated gp numbers in crm_reference_registry. Global identifiers
-- are never reused, including identifiers retired by this cleanup.

-- Retryable outbox errors are still in progress. Reserve the user-facing failed
-- state for records whose outbox item exhausted all retries and became dead.
WITH retryable AS (
  SELECT aggregate_type, aggregate_id
  FROM sync_outbox
  WHERE target_system = 'suitecrm'
    AND status = 'failed'
)
UPDATE crm_products product
SET sync_status = 'pending', updated_at = now()
FROM retryable
WHERE retryable.aggregate_type = 'crm_products'
  AND retryable.aggregate_id = product.id::text
  AND product.sync_status = 'failed';

WITH atomic_options AS (
  SELECT
    catalog.pipeline_id,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'value', product.name,
          'label', product.name,
          'active', true,
          'sort_order', product.sort_order
        )
        ORDER BY product.sort_order
      ) FILTER (WHERE product.name IS NOT NULL),
      '[]'::jsonb
    ) AS options
  FROM pipeline_dropdown_catalogs catalog
  LEFT JOIN LATERAL (
    SELECT
      product.name,
      row_number() OVER (ORDER BY lower(product.name), product.name) - 1 AS sort_order
    FROM crm_products product
    WHERE product.pipeline_id = catalog.pipeline_id
      AND product.active = true
  ) product ON true
  GROUP BY catalog.pipeline_id
), legacy_workflow_catalogs AS (
  SELECT
    catalog.pipeline_id,
    COALESCE((
      SELECT jsonb_agg(
        CASE lower(COALESCE(option->>'label', option->>'value', ''))
          WHEN 'neogotiation' THEN jsonb_build_object(
            'value', 'Negotiation',
            'label', 'Negotiation',
            'active', COALESCE((option->>'active')::boolean, true),
            'sort_order', COALESCE((option->>'sort_order')::integer, ordinal - 1)
          )
          ELSE option
        END
        ORDER BY ordinal
      )
      FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'status')
        WITH ORDINALITY AS stage(option, ordinal)
    ), '[]'::jsonb) AS stages,
    catalog.catalog->'dropdowns'->'loss_reason' AS priorities,
    catalog.catalog->'dropdowns'->'interaction' AS sources,
    catalog.catalog->'dropdowns'->'acct_manager' AS loss_reasons
  FROM pipeline_dropdown_catalogs catalog
  WHERE jsonb_typeof(catalog.catalog->'dropdowns'->'status') = 'array'
    AND jsonb_typeof(catalog.catalog->'dropdowns'->'loss_reason') = 'array'
    AND jsonb_typeof(catalog.catalog->'dropdowns'->'interaction') = 'array'
    AND jsonb_typeof(catalog.catalog->'dropdowns'->'acct_manager') = 'array'
    AND jsonb_typeof(catalog.catalog->'dropdowns'->'source') = 'array'
    AND jsonb_typeof(catalog.catalog->'dropdowns'->'product') = 'array'
    AND COALESCE(catalog.catalog->'dropdowns'->'source'->0->>'value', '')
      = COALESCE(catalog.catalog->'dropdowns'->'product'->0->>'value', '')
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'status') option
      WHERE lower(COALESCE(option->>'label', option->>'value', '')) = 'identified lead'
    )
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'loss_reason') option
      WHERE upper(COALESCE(option->>'label', option->>'value', '')) = 'A+'
    )
), canonical_options AS (
  SELECT
    atomic.pipeline_id,
    atomic.options AS products,
    legacy.stages,
    legacy.priorities,
    legacy.sources,
    legacy.loss_reasons
  FROM atomic_options atomic
  LEFT JOIN legacy_workflow_catalogs legacy ON legacy.pipeline_id = atomic.pipeline_id
), normalized_catalogs AS (
  UPDATE pipeline_dropdown_catalogs catalog
  SET catalog = CASE
        WHEN canonical.stages IS NULL THEN
          jsonb_set(
            catalog.catalog #- '{dropdowns,products}',
            '{dropdowns,product}',
            canonical.products,
            true
          )
        ELSE
          jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  jsonb_set(
                    jsonb_set(
                      catalog.catalog #- '{dropdowns,products}',
                      '{dropdowns,product}', canonical.products, true
                    ),
                    '{dropdowns,stage}', canonical.stages, true
                  ),
                  '{dropdowns,priority}', canonical.priorities, true
                ),
                '{dropdowns,status}',
                '[
                  {"value":"Open","label":"Open","active":true,"sort_order":0},
                  {"value":"On Hold","label":"On Hold","active":true,"sort_order":1},
                  {"value":"Closed","label":"Closed","active":true,"sort_order":2},
                  {"value":"Won","label":"Won","active":true,"sort_order":3},
                  {"value":"Lost","label":"Lost","active":true,"sort_order":4},
                  {"value":"Abandoned","label":"Abandoned","active":true,"sort_order":5}
                ]'::jsonb,
                true
              ),
              '{dropdowns,source}', canonical.sources, true
            ),
            '{dropdowns,loss_reason}', canonical.loss_reasons, true
          )
      END,
      source = 'app',
      desired_revision = CASE
        WHEN pipeline.sync_enabled AND pipeline.sheet_id IS NOT NULL
          THEN catalog.desired_revision + 1
        ELSE catalog.desired_revision
      END,
      updated_at = now()
  FROM canonical_options canonical
  JOIN pipeline_spaces pipeline ON pipeline.id = canonical.pipeline_id
  WHERE catalog.pipeline_id = canonical.pipeline_id
  RETURNING catalog.pipeline_id, catalog.catalog, catalog.desired_revision
)
UPDATE app_settings setting
SET value = normalized.catalog,
    updated_at = now()
FROM normalized_catalogs normalized
WHERE setting.key = 'pipeline.dropdowns.current:' || normalized.pipeline_id::text;

-- Push the canonical workflow and atomic product catalog back to managed Sheets.
-- This prevents a later pull from restoring the legacy shifted columns.
INSERT INTO sync_outbox (
  aggregate_type,
  aggregate_id,
  operation,
  target_system,
  payload,
  status,
  attempts,
  idempotency_key,
  created_at,
  available_at,
  updated_at
)
SELECT
  'pipeline_dropdowns',
  catalog.pipeline_id::text,
  'patch_dropdowns',
  'google_sheets',
  jsonb_build_object(
    'pipelineId', catalog.pipeline_id::text,
    'sheetId', pipeline.sheet_id,
    'catalogRevision', catalog.desired_revision,
    'catalog', jsonb_build_object(
      'source', 'app',
      'syncedAt', now(),
      'dropdowns', jsonb_strip_nulls(jsonb_build_object(
        'product', catalog.catalog->'dropdowns'->'product',
        'stage', catalog.catalog->'dropdowns'->'stage',
        'priority', catalog.catalog->'dropdowns'->'priority',
        'status', catalog.catalog->'dropdowns'->'status',
        'source', catalog.catalog->'dropdowns'->'source',
        'loss_reason', catalog.catalog->'dropdowns'->'loss_reason'
      ))
    )
  ),
  'queued',
  0,
  'pipeline:' || catalog.pipeline_id::text || ':pipeline-catalog-canonical:v1',
  now(),
  now(),
  now()
FROM pipeline_dropdown_catalogs catalog
JOIN pipeline_spaces pipeline ON pipeline.id = catalog.pipeline_id
WHERE pipeline.sync_enabled = true
  AND pipeline.sheet_id IS NOT NULL
ON CONFLICT (target_system, idempotency_key)
WHERE idempotency_key IS NOT NULL
DO NOTHING;

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
  pipeline.owner_email,
  'pipeline.product_catalog.normalized',
  'pipeline_space',
  combination.pipeline_id::text,
  jsonb_build_object(
    'pipelineId', combination.pipeline_id::text,
    'retiredCombinationProducts', count(*),
    'globalIdentifiersRetained', true
  ),
  'pipeline-product-catalog-normalized:' || combination.pipeline_id::text,
  now()
FROM generated_product_combinations combination
JOIN pipeline_spaces pipeline ON pipeline.id = combination.pipeline_id
GROUP BY combination.pipeline_id, pipeline.owner_email
ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING;
