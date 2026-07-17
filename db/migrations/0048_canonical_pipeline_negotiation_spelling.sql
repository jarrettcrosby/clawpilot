-- Correct the historical stage spelling wherever it still survives in an
-- existing catalog. The normalizer also enforces this boundary for future
-- Sheet pulls, so a stale workbook cannot restore the typo in the app.
CREATE TEMP TABLE corrected_pipeline_stages ON COMMIT DROP AS
SELECT
  catalog.pipeline_id,
  (
    SELECT jsonb_agg(
      CASE
        WHEN lower(COALESCE(option->>'value', option->>'label', '')) = 'neogotiation'
          OR lower(COALESCE(option->>'label', option->>'value', '')) = 'neogotiation'
        THEN option || jsonb_build_object('value', 'Negotiation', 'label', 'Negotiation')
        ELSE option
      END
      ORDER BY ordinal
    )
    FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'stage')
      WITH ORDINALITY AS stage(option, ordinal)
  ) AS stage_options
FROM pipeline_dropdown_catalogs catalog
WHERE jsonb_typeof(catalog.catalog->'dropdowns'->'stage') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'stage') option
    WHERE lower(COALESCE(option->>'value', option->>'label', '')) = 'neogotiation'
      OR lower(COALESCE(option->>'label', option->>'value', '')) = 'neogotiation'
  );

UPDATE pipeline_dropdown_catalogs catalog
SET catalog = jsonb_set(catalog.catalog, '{dropdowns,stage}', corrected.stage_options, true),
    source = 'app',
    desired_revision = CASE
      WHEN pipeline.sync_enabled AND pipeline.sheet_id IS NOT NULL
        THEN catalog.desired_revision + 1
      ELSE catalog.desired_revision
    END,
    updated_at = now()
FROM corrected_pipeline_stages corrected
JOIN pipeline_spaces pipeline ON pipeline.id = corrected.pipeline_id
WHERE catalog.pipeline_id = corrected.pipeline_id;

UPDATE app_settings setting
SET value = catalog.catalog,
    updated_at = now()
FROM corrected_pipeline_stages corrected
JOIN pipeline_dropdown_catalogs catalog ON catalog.pipeline_id = corrected.pipeline_id
WHERE setting.key = 'pipeline.dropdowns.current:' || corrected.pipeline_id::text;

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
  corrected.pipeline_id::text,
  'patch_dropdowns',
  'google_sheets',
  jsonb_build_object(
    'pipelineId', corrected.pipeline_id::text,
    'sheetId', pipeline.sheet_id,
    'catalogRevision', catalog.desired_revision,
    'catalog', jsonb_build_object(
      'source', 'app',
      'syncedAt', now(),
      'dropdowns', jsonb_build_object('stage', corrected.stage_options)
    )
  ),
  'queued',
  0,
  'pipeline:' || corrected.pipeline_id::text || ':negotiation-spelling:v1',
  now(),
  now(),
  now()
FROM corrected_pipeline_stages corrected
JOIN pipeline_dropdown_catalogs catalog ON catalog.pipeline_id = corrected.pipeline_id
JOIN pipeline_spaces pipeline ON pipeline.id = corrected.pipeline_id
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
  'pipeline.workflow_spelling.normalized',
  'pipeline_space',
  corrected.pipeline_id::text,
  jsonb_build_object('pipelineId', corrected.pipeline_id::text, 'stage', 'Negotiation'),
  'pipeline-workflow-spelling-normalized:' || corrected.pipeline_id::text,
  now()
FROM corrected_pipeline_stages corrected
JOIN pipeline_spaces pipeline ON pipeline.id = corrected.pipeline_id
ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING;
