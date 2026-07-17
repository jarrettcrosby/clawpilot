-- CRM workbook projection previously rewrote the existing Dropdowns tab with
-- onboarding defaults on every projection. Repair the configured owner's exact
-- historical 13-product pipeline fingerprint in each environment. Other tenant
-- catalogs remain untouched.
CREATE TEMP TABLE historical_dropdown_projection_regressions ON COMMIT DROP AS
SELECT catalog.pipeline_id
FROM pipeline_dropdown_catalogs catalog
JOIN pipeline_spaces pipeline ON pipeline.id = catalog.pipeline_id
WHERE pipeline.owner_email = 'jarrett@suburbiasandwichco.com'
  AND pipeline.is_default = true
  AND jsonb_typeof(catalog.catalog->'dropdowns'->'product') = 'array'
  AND jsonb_array_length(catalog.catalog->'dropdowns'->'product') = 13
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'product') option
    WHERE lower(COALESCE(option->>'value', option->>'label', '')) NOT IN (
      'aar', 'lds', 'cao', 'cac', 'glc', 'tia', 'pod', 'dts', 'cpr', 'ptp',
      'merchant y140', 'merchant y140 & y182', 'merchant y182'
    )
  )
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(catalog.catalog->'dropdowns'->'product') option
    WHERE upper(COALESCE(option->>'value', option->>'label', '')) = 'AAR'
  );

CREATE TEMP TABLE historical_dropdown_projection_repairs ON COMMIT DROP AS
SELECT
  regression.pipeline_id,
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                catalog.catalog,
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
              '{dropdowns,priority}',
              '[
                {"value":"A+","label":"A+","active":true,"sort_order":0},
                {"value":"A","label":"A","active":true,"sort_order":1},
                {"value":"B","label":"B","active":true,"sort_order":2},
                {"value":"C","label":"C","active":true,"sort_order":3},
                {"value":"D","label":"D","active":true,"sort_order":4}
              ]'::jsonb,
              true
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
        '{dropdowns,loss_reason}',
        '[
          {"value":"Price","label":"Price","active":true,"sort_order":0},
          {"value":"Functionality","label":"Functionality","active":true,"sort_order":1},
          {"value":"Competitor","label":"Competitor","active":true,"sort_order":2},
          {"value":"Complaint","label":"Complaint","active":true,"sort_order":3},
          {"value":"Other","label":"Other","active":true,"sort_order":4}
        ]'::jsonb,
        true
      ),
      '{source}', '"app"'::jsonb, true
    ),
    '{syncedAt}', to_jsonb(now()::text), true
  ) AS catalog
FROM historical_dropdown_projection_regressions regression
JOIN pipeline_dropdown_catalogs catalog ON catalog.pipeline_id = regression.pipeline_id;

UPDATE pipeline_dropdown_catalogs catalog
SET catalog = repair.catalog,
    source = 'app',
    desired_revision = CASE
      WHEN pipeline.sync_enabled AND pipeline.sheet_id IS NOT NULL
        THEN catalog.desired_revision + 1
      ELSE catalog.desired_revision
    END,
    updated_at = now()
FROM historical_dropdown_projection_repairs repair
JOIN pipeline_spaces pipeline ON pipeline.id = repair.pipeline_id
WHERE catalog.pipeline_id = repair.pipeline_id;

UPDATE app_settings setting
SET value = repair.catalog,
    updated_at = now()
FROM historical_dropdown_projection_repairs repair
WHERE setting.key IN (
  'pipeline.dropdowns.current',
  'pipeline.dropdowns.current:' || repair.pipeline_id::text
);

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
        'stage', repair.catalog->'dropdowns'->'stage',
        'priority', repair.catalog->'dropdowns'->'priority',
        'status', repair.catalog->'dropdowns'->'status',
        'source', repair.catalog->'dropdowns'->'source',
        'loss_reason', repair.catalog->'dropdowns'->'loss_reason'
      )
    )
  ),
  'queued',
  0,
  'pipeline:' || repair.pipeline_id::text || ':projection-default-repair:v1',
  now(),
  now(),
  now()
FROM historical_dropdown_projection_repairs repair
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
  'pipeline.dropdown_projection_defaults.repaired',
  'pipeline_space',
  repair.pipeline_id::text,
  jsonb_build_object(
    'pipelineId', repair.pipeline_id::text,
    'fields', jsonb_build_array('stage', 'priority', 'status', 'source', 'loss_reason'),
    'rootCause', 'existing Dropdowns tab was reseeded during CRM workbook projection'
  ),
  'pipeline-dropdown-projection-defaults-repaired:' || repair.pipeline_id::text,
  now()
FROM historical_dropdown_projection_repairs repair
JOIN pipeline_spaces pipeline ON pipeline.id = repair.pipeline_id
ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING;
