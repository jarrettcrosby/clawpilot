-- The configured owner's legacy Sheet expanded atomic products into every
-- selected combination. crm_products remains the authority for the 13 atomic
-- products; opportunities relate to many products through
-- crm_opportunity_products. Repair only that exact database fingerprint after
-- CRM workbook projection relabeled sorted Dropdowns columns.
CREATE TEMP TABLE canonical_dropdown_layout_regressions ON COMMIT DROP AS
SELECT pipeline.id AS pipeline_id
FROM pipeline_spaces pipeline
JOIN pipeline_dropdown_catalogs catalog ON catalog.pipeline_id = pipeline.id
WHERE pipeline.owner_email = 'jarrett@suburbiasandwichco.com'
  AND pipeline.is_default = true
  AND (
    SELECT count(*)
    FROM crm_products product
    WHERE product.pipeline_id = pipeline.id
      AND product.active = true
  ) = 13
  AND NOT EXISTS (
    SELECT 1
    FROM crm_products product
    WHERE product.pipeline_id = pipeline.id
      AND product.active = true
      AND lower(product.name) NOT IN (
        'aar', 'lds', 'cao', 'cac', 'glc', 'tia', 'pod', 'dts', 'cpr', 'ptp',
        'merchant y140', 'merchant y140 & y182', 'merchant y182'
      )
  );

CREATE TEMP TABLE canonical_dropdown_layout_repairs ON COMMIT DROP AS
WITH owner_candidates AS (
  SELECT
    regression.pipeline_id,
    COALESCE(NULLIF(app_user.display_name, ''), app_user.email) AS label,
    lower(regexp_replace(
      COALESCE(NULLIF(app_user.display_name, ''), app_user.email),
      '[[:space:]]+', ' ', 'g'
    )) AS normalized_label,
    0 AS source_order,
    app_user.email AS source_key,
    contact.id::text AS source_id
  FROM canonical_dropdown_layout_regressions regression
  JOIN pipeline_spaces pipeline ON pipeline.id = regression.pipeline_id
  JOIN app_users app_user
    ON app_user.organization_id = pipeline.workspace_organization_id
   AND app_user.status = 'active'
  JOIN crm_contacts contact
    ON contact.pipeline_id = pipeline.id
   AND contact.app_user_email = app_user.email

  UNION ALL

  SELECT
    regression.pipeline_id,
    contact.full_name AS label,
    lower(regexp_replace(contact.full_name, '[[:space:]]+', ' ', 'g')) AS normalized_label,
    1 AS source_order,
    COALESCE(contact.email, '') AS source_key,
    contact.id::text AS source_id
  FROM canonical_dropdown_layout_regressions regression
  JOIN pipeline_spaces pipeline ON pipeline.id = regression.pipeline_id
  JOIN crm_organizations organization
    ON organization.pipeline_id = pipeline.id
   AND organization.workspace_organization_id = pipeline.workspace_organization_id
  JOIN crm_contacts contact
    ON contact.pipeline_id = pipeline.id
   AND contact.organization_id = organization.id
  WHERE contact.pipeline_user = true
    AND contact.app_user_email IS NULL
    AND lower(COALESCE(contact.source_payload->>'active', 'true'))
      NOT IN ('false', '0', 'no', 'inactive')
    AND NOT EXISTS (
      SELECT 1
      FROM app_users app_user
      WHERE app_user.email = lower(COALESCE(contact.email, ''))
    )
),
deduplicated_owners AS (
  SELECT pipeline_id, label
  FROM (
    SELECT candidate.*,
      row_number() OVER (
        PARTITION BY pipeline_id, normalized_label
        ORDER BY source_order, lower(source_key), source_id
      ) AS duplicate_order
    FROM owner_candidates candidate
    WHERE length(btrim(label)) > 0
  ) ranked
  WHERE duplicate_order = 1
),
owner_options AS (
  SELECT pipeline_id,
    jsonb_agg(
      jsonb_build_object(
        'value', label,
        'label', label,
        'active', true,
        'sort_order', sort_order
      ) ORDER BY sort_order
    ) AS options
  FROM (
    SELECT pipeline_id, label,
      row_number() OVER (
        PARTITION BY pipeline_id
        ORDER BY lower(label), label
      ) - 1 AS sort_order
    FROM deduplicated_owners
  ) ordered
  GROUP BY pipeline_id
),
product_options AS (
  SELECT pipeline_id,
    jsonb_agg(
      jsonb_build_object(
        'value', name,
        'label', name,
        'active', true,
        'sort_order', sort_order
      ) ORDER BY sort_order
    ) AS options
  FROM (
    SELECT product.pipeline_id, product.name,
      row_number() OVER (
        PARTITION BY product.pipeline_id
        ORDER BY lower(product.name), product.name, product.id
      ) - 1 AS sort_order
    FROM crm_products product
    JOIN canonical_dropdown_layout_regressions regression
      ON regression.pipeline_id = product.pipeline_id
    WHERE product.active = true
  ) ordered
  GROUP BY pipeline_id
),
canonical_components AS (
  SELECT
    regression.pipeline_id,
    COALESCE(owner.options, '[]'::jsonb) AS owner_options,
    product.options AS product_options,
    CASE
      WHEN jsonb_typeof(catalog.catalog->'dropdowns'->'state') = 'array'
        AND jsonb_array_length(catalog.catalog->'dropdowns'->'state') >= 50
        THEN catalog.catalog->'dropdowns'->'state'
      WHEN jsonb_typeof(catalog.catalog->'dropdowns'->'loss_reason') = 'array'
        AND jsonb_array_length(catalog.catalog->'dropdowns'->'loss_reason') >= 50
        THEN catalog.catalog->'dropdowns'->'loss_reason'
      ELSE '[]'::jsonb
    END AS state_options,
    catalog.catalog
  FROM canonical_dropdown_layout_regressions regression
  JOIN pipeline_dropdown_catalogs catalog ON catalog.pipeline_id = regression.pipeline_id
  JOIN product_options product ON product.pipeline_id = regression.pipeline_id
  LEFT JOIN owner_options owner ON owner.pipeline_id = regression.pipeline_id
)
SELECT
  component.pipeline_id,
  (component.catalog - 'source' - 'syncedAt' - 'dropdowns')
    || jsonb_build_object(
      'source', 'app',
      'syncedAt', now(),
      'dropdowns',
        (
          COALESCE(component.catalog->'dropdowns', '{}'::jsonb)
            - 'products' - 'interaction' - 'acct_manager'
        ) || jsonb_build_object(
          'owner', component.owner_options,
          'product', component.product_options,
          'stage', '[
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
          'priority', '[
            {"value":"A+","label":"A+","active":true,"sort_order":0},
            {"value":"A","label":"A","active":true,"sort_order":1},
            {"value":"B","label":"B","active":true,"sort_order":2},
            {"value":"C","label":"C","active":true,"sort_order":3},
            {"value":"D","label":"D","active":true,"sort_order":4}
          ]'::jsonb,
          'status', '[
            {"value":"Open","label":"Open","active":true,"sort_order":0},
            {"value":"Closed","label":"Closed","active":true,"sort_order":1},
            {"value":"Lost","label":"Lost","active":true,"sort_order":2},
            {"value":"Abandoned","label":"Abandoned","active":true,"sort_order":3},
            {"value":"On Hold","label":"On Hold","active":true,"sort_order":4}
          ]'::jsonb,
          'source', '[
            {"value":"Linkedin","label":"Linkedin","active":true,"sort_order":0},
            {"value":"Email","label":"Email","active":true,"sort_order":1},
            {"value":"Phone Outreach","label":"Phone Outreach","active":true,"sort_order":2},
            {"value":"Networking","label":"Networking","active":true,"sort_order":3},
            {"value":"Website","label":"Website","active":true,"sort_order":4},
            {"value":"Account Transition","label":"Account Transition","active":true,"sort_order":5},
            {"value":"Trade Show","label":"Trade Show","active":true,"sort_order":6}
          ]'::jsonb,
          'loss_reason', '[
            {"value":"Price","label":"Price","active":true,"sort_order":0},
            {"value":"Functionality","label":"Functionality","active":true,"sort_order":1},
            {"value":"Competitor","label":"Competitor","active":true,"sort_order":2},
            {"value":"Complaint","label":"Complaint","active":true,"sort_order":3},
            {"value":"Other","label":"Other","active":true,"sort_order":4}
          ]'::jsonb,
          'state', component.state_options
        )
    ) AS catalog
FROM canonical_components component;

UPDATE pipeline_dropdown_catalogs catalog
SET catalog = repair.catalog,
    source = 'app',
    desired_revision = CASE
      WHEN pipeline.sync_enabled AND pipeline.sheet_id IS NOT NULL
        THEN catalog.desired_revision + 1
      ELSE catalog.desired_revision
    END,
    updated_at = now()
FROM canonical_dropdown_layout_repairs repair
JOIN pipeline_spaces pipeline ON pipeline.id = repair.pipeline_id
WHERE catalog.pipeline_id = repair.pipeline_id;

UPDATE app_settings setting
SET value = repair.catalog,
    updated_at = now()
FROM canonical_dropdown_layout_repairs repair
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
    'catalog', repair.catalog
  ),
  'queued',
  0,
  'pipeline:' || repair.pipeline_id::text || ':canonical-dropdown-layout-repair:v1',
  now(),
  now(),
  now()
FROM canonical_dropdown_layout_repairs repair
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
  'pipeline.canonical_dropdown_layout.restored',
  'pipeline_space',
  repair.pipeline_id::text,
  jsonb_build_object(
    'pipelineId', repair.pipeline_id::text,
    'atomicProductCount', 13,
    'productModel', 'many-to-many',
    'fields', jsonb_build_array(
      'owner', 'product', 'stage', 'priority', 'status', 'source', 'loss_reason', 'state'
    ),
    'rootCause', 'CRM workbook projection relabeled sorted Dropdowns columns'
  ),
  'pipeline-canonical-dropdown-layout-restored:' || repair.pipeline_id::text,
  now()
FROM canonical_dropdown_layout_repairs repair
JOIN pipeline_spaces pipeline ON pipeline.id = repair.pipeline_id
ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING;
