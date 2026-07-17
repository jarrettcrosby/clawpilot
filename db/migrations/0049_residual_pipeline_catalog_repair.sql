-- Repair the older production workbook shape that duplicated owners into
-- Stage/Status and stored product combinations under Source/Interaction. The
-- guard intentionally matches all of those signals so normal user catalogs are
-- never rewritten.
CREATE TEMP TABLE residual_pipeline_catalogs ON COMMIT DROP AS
SELECT catalog.pipeline_id
FROM pipeline_dropdown_catalogs catalog
WHERE jsonb_typeof(catalog.catalog->'dropdowns'->'owner') = 'array'
  AND jsonb_typeof(catalog.catalog->'dropdowns'->'stage') = 'array'
  AND jsonb_typeof(catalog.catalog->'dropdowns'->'status') = 'array'
  AND jsonb_typeof(catalog.catalog->'dropdowns'->'source') = 'array'
  AND jsonb_typeof(catalog.catalog->'dropdowns'->'product') = 'array'
  AND jsonb_typeof(catalog.catalog->'dropdowns'->'loss_reason') = 'array'
  AND jsonb_typeof(catalog.catalog->'dropdowns'->'acct_manager') = 'array'
  AND catalog.catalog->'dropdowns'->'stage' = catalog.catalog->'dropdowns'->'owner'
  AND catalog.catalog->'dropdowns'->'status' = catalog.catalog->'dropdowns'->'owner'
  AND jsonb_array_length(catalog.catalog->'dropdowns'->'source') >= 100
  AND jsonb_array_length(catalog.catalog->'dropdowns'->'product') > 13
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'source') option
    WHERE COALESCE(option->>'value', option->>'label', '') LIKE '%,%'
  )
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'product') option
    WHERE lower(COALESCE(option->>'value', option->>'label', '')) = 'identified lead'
  )
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'product') option
    WHERE lower(COALESCE(option->>'value', option->>'label', '')) = 'open'
  )
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'loss_reason') option
    WHERE upper(COALESCE(option->>'value', option->>'label', '')) = 'A+'
  )
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'acct_manager') option
    WHERE lower(COALESCE(option->>'value', option->>'label', '')) = 'price'
  );

CREATE TEMP TABLE residual_canonical_products ON COMMIT DROP AS
WITH product_tokens AS (
  SELECT DISTINCT
    residual.pipeline_id,
    btrim(token) AS name
  FROM residual_pipeline_catalogs residual
  JOIN pipeline_dropdown_catalogs catalog ON catalog.pipeline_id = residual.pipeline_id
  CROSS JOIN LATERAL jsonb_array_elements(catalog.catalog->'dropdowns'->'source') option
  CROSS JOIN LATERAL regexp_split_to_table(
    COALESCE(option->>'value', option->>'label', ''),
    '\s*,\s*'
  ) token
  WHERE NULLIF(btrim(token), '') IS NOT NULL
    AND lower(btrim(token)) <> ALL (ARRAY[
      'identified lead', 'qualified lead', 'needs analysis', 'demo', 'proposal',
      'neogotiation', 'negotiation', 'closed', 'closed delayed', 'loss',
      'open', 'lost', 'abandoned', 'on hold', 'won'
    ])
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'owner') owner
      WHERE lower(COALESCE(owner->>'value', owner->>'label', '')) = lower(btrim(token))
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'loss_reason') priority
      WHERE lower(COALESCE(priority->>'value', priority->>'label', '')) = lower(btrim(token))
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'acct_manager') reason
      WHERE lower(COALESCE(reason->>'value', reason->>'label', '')) = lower(btrim(token))
    )
), ordered_products AS (
  SELECT
    pipeline_id,
    name,
    row_number() OVER (PARTITION BY pipeline_id ORDER BY lower(name), name) - 1 AS sort_order
  FROM product_tokens
)
SELECT
  pipeline_id,
  jsonb_agg(
    jsonb_build_object(
      'value', name,
      'label', name,
      'active', true,
      'sort_order', sort_order
    )
    ORDER BY sort_order
  ) AS options
FROM ordered_products
GROUP BY pipeline_id;

CREATE TEMP TABLE residual_invalid_products ON COMMIT DROP AS
SELECT
  product.id,
  product.pipeline_id,
  product.suitecrm_id,
  product.reference_code,
  product.name
FROM crm_products product
JOIN residual_pipeline_catalogs residual ON residual.pipeline_id = product.pipeline_id
JOIN residual_canonical_products canonical ON canonical.pipeline_id = product.pipeline_id
WHERE product.source_payload->>'source' = 'clawpilot_pipeline_catalog_bootstrap'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(canonical.options) option
    WHERE lower(COALESCE(option->>'value', option->>'label', '')) = lower(product.name)
  );

DELETE FROM crm_opportunity_products relationship
USING residual_invalid_products invalid
WHERE relationship.pipeline_id = invalid.pipeline_id
  AND relationship.product_id = invalid.id;

DELETE FROM sync_outbox outbox
USING residual_invalid_products invalid
WHERE outbox.target_system = 'suitecrm'
  AND outbox.aggregate_type = 'crm_products'
  AND outbox.aggregate_id = invalid.id::text;

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
  invalid.id::text,
  'delete_record',
  'suitecrm',
  jsonb_build_object(
    'entity', 'products',
    'pipelineId', invalid.pipeline_id::text,
    'localId', invalid.id::text,
    'suiteCrmId', invalid.suitecrm_id,
    'attributes', '{}'::jsonb
  ),
  'queued',
  0,
  'crm:products:residual-catalog-cleanup:v1:' || invalid.id::text,
  now(),
  now(),
  now()
FROM residual_invalid_products invalid
WHERE NULLIF(btrim(invalid.suitecrm_id), '') IS NOT NULL
ON CONFLICT (target_system, idempotency_key)
WHERE idempotency_key IS NOT NULL
DO NOTHING;

DELETE FROM crm_products product
USING residual_invalid_products invalid
WHERE product.id = invalid.id;

-- crm_reference_registry remains untouched. Retired gp identifiers can never be
-- allocated again even after the invalid local and SuiteCRM records are gone.

CREATE TEMP TABLE residual_catalog_updates ON COMMIT DROP AS
SELECT
  residual.pipeline_id,
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  (
                    catalog.catalog
                      #- '{dropdowns,products}'
                      #- '{dropdowns,interaction}'
                      #- '{dropdowns,acct_manager}'
                  ),
                  '{dropdowns,product}', canonical.options, true
                ),
                '{dropdowns,stage}',
                '[
                  {"value":"Identified Lead","label":"Identified Lead","active":true,"sort_order":0},
                  {"value":"Qualified Lead","label":"Qualified Lead","active":true,"sort_order":1},
                  {"value":"Needs Analysis","label":"Needs Analysis","active":true,"sort_order":2},
                  {"value":"Demo","label":"Demo","active":true,"sort_order":3},
                  {"value":"Proposal","label":"Proposal","active":true,"sort_order":4},
                  {"value":"Negotiation","label":"Negotiation","active":true,"sort_order":5},
                  {"value":"Closed","label":"Closed","active":true,"sort_order":6},
                  {"value":"Closed Delayed","label":"Closed Delayed","active":true,"sort_order":7},
                  {"value":"Loss","label":"Loss","active":true,"sort_order":8}
                ]'::jsonb,
                true
              ),
              '{dropdowns,priority}', catalog.catalog->'dropdowns'->'loss_reason', true
            ),
            '{dropdowns,status}',
            '[
              {"value":"Open","label":"Open","active":true,"sort_order":0},
              {"value":"Closed","label":"Closed","active":true,"sort_order":1},
              {"value":"Lost","label":"Lost","active":true,"sort_order":2},
              {"value":"Abandoned","label":"Abandoned","active":true,"sort_order":3},
              {"value":"On Hold","label":"On Hold","active":true,"sort_order":4}
            ]'::jsonb,
            true
          ),
          '{dropdowns,source}',
          '[
            {"value":"Linkedin","label":"Linkedin","active":true,"sort_order":0},
            {"value":"Email","label":"Email","active":true,"sort_order":1},
            {"value":"Phone Outreach","label":"Phone Outreach","active":true,"sort_order":2},
            {"value":"Networking","label":"Networking","active":true,"sort_order":3},
            {"value":"Website","label":"Website","active":true,"sort_order":4},
            {"value":"Account Transition","label":"Account Transition","active":true,"sort_order":5},
            {"value":"Trade Show","label":"Trade Show","active":true,"sort_order":6}
          ]'::jsonb,
          true
        ),
        '{dropdowns,loss_reason}', catalog.catalog->'dropdowns'->'acct_manager', true
      ),
      '{source}', '"app"'::jsonb, true
    ),
    '{syncedAt}', to_jsonb(now()::text), true
  ) AS catalog
FROM residual_pipeline_catalogs residual
JOIN pipeline_dropdown_catalogs catalog ON catalog.pipeline_id = residual.pipeline_id
JOIN residual_canonical_products canonical ON canonical.pipeline_id = residual.pipeline_id;

UPDATE pipeline_dropdown_catalogs catalog
SET catalog = repair.catalog,
    source = 'app',
    desired_revision = CASE
      WHEN pipeline.sync_enabled AND pipeline.sheet_id IS NOT NULL
        THEN catalog.desired_revision + 1
      ELSE catalog.desired_revision
    END,
    updated_at = now()
FROM residual_catalog_updates repair
JOIN pipeline_spaces pipeline ON pipeline.id = repair.pipeline_id
WHERE catalog.pipeline_id = repair.pipeline_id;

UPDATE app_settings setting
SET value = repair.catalog,
    updated_at = now()
FROM residual_catalog_updates repair
WHERE setting.key = 'pipeline.dropdowns.current:' || repair.pipeline_id::text;

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
  repair.pipeline_id::text,
  'patch_dropdowns',
  'google_sheets',
  jsonb_build_object(
    'pipelineId', repair.pipeline_id::text,
    'sheetId', pipeline.sheet_id,
    'catalogRevision', catalog.desired_revision,
    'catalog', jsonb_build_object(
      'source', 'app',
      'syncedAt', now(),
      'dropdowns', jsonb_build_object(
        'owner', repair.catalog->'dropdowns'->'owner',
        'product', repair.catalog->'dropdowns'->'product',
        'stage', repair.catalog->'dropdowns'->'stage',
        'priority', repair.catalog->'dropdowns'->'priority',
        'status', repair.catalog->'dropdowns'->'status',
        'source', repair.catalog->'dropdowns'->'source',
        'loss_reason', repair.catalog->'dropdowns'->'loss_reason',
        'interaction', '[]'::jsonb,
        'acct_manager', '[]'::jsonb
      )
    )
  ),
  'queued',
  0,
  'pipeline:' || repair.pipeline_id::text || ':residual-catalog-repair:v1',
  now(),
  now(),
  now()
FROM residual_catalog_updates repair
JOIN pipeline_dropdown_catalogs catalog ON catalog.pipeline_id = repair.pipeline_id
JOIN pipeline_spaces pipeline ON pipeline.id = repair.pipeline_id
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
  'pipeline.residual_catalog.normalized',
  'pipeline_space',
  repair.pipeline_id::text,
  jsonb_build_object(
    'pipelineId', repair.pipeline_id::text,
    'retiredInvalidProducts', (
      SELECT count(*)
      FROM residual_invalid_products invalid
      WHERE invalid.pipeline_id = repair.pipeline_id
    ),
    'canonicalProducts', repair.catalog->'dropdowns'->'product',
    'globalIdentifiersRetained', true
  ),
  'pipeline-residual-catalog-normalized:' || repair.pipeline_id::text,
  now()
FROM residual_catalog_updates repair
JOIN pipeline_spaces pipeline ON pipeline.id = repair.pipeline_id
ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING;
