-- Pipelines created before the base template could already have an empty
-- catalog row. Seed only catalogs with no workflow configuration and preserve
-- products plus any unrelated catalog metadata.
WITH base_options(kind, value, sort_order) AS (
  VALUES
    ('stage', 'Identified Lead', 0),
    ('stage', 'Qualified Lead', 1),
    ('stage', 'Needs Analysis', 2),
    ('stage', 'Demo', 3),
    ('stage', 'Proposal', 4),
    ('stage', 'Negotiation', 5),
    ('stage', 'Loss', 6),
    ('stage', 'Won', 7),
    ('priority', 'A+', 0),
    ('priority', 'A', 1),
    ('priority', 'B', 2),
    ('priority', 'C', 3),
    ('priority', 'D', 4),
    ('status', 'Open', 0),
    ('status', 'On Hold', 1),
    ('status', 'Won', 2),
    ('status', 'Lost', 3),
    ('status', 'Abandoned', 4),
    ('source', 'Inbound', 0),
    ('source', 'Outbound', 1),
    ('source', 'Referral', 2),
    ('source', 'Website', 3),
    ('source', 'Partner', 4),
    ('loss_reason', 'No Decision', 0),
    ('loss_reason', 'Budget', 1),
    ('loss_reason', 'Competition', 2),
    ('loss_reason', 'Not a Fit', 3)
),
base_dropdowns AS (
  SELECT jsonb_object_agg(kind, options) AS value
  FROM (
    SELECT
      kind,
      jsonb_agg(
        jsonb_build_object(
          'value', value,
          'label', value,
          'active', true,
          'sort_order', sort_order
        )
        ORDER BY sort_order
      ) AS options
    FROM base_options
    GROUP BY kind
  ) grouped
),
empty_catalogs AS (
  SELECT catalog.pipeline_id
  FROM pipeline_dropdown_catalogs catalog
  WHERE COALESCE(jsonb_array_length(
          CASE WHEN jsonb_typeof(catalog.catalog->'dropdowns'->'stage') = 'array'
            THEN catalog.catalog->'dropdowns'->'stage' ELSE '[]'::jsonb END
        ), 0) = 0
    AND COALESCE(jsonb_array_length(
          CASE WHEN jsonb_typeof(catalog.catalog->'dropdowns'->'priority') = 'array'
            THEN catalog.catalog->'dropdowns'->'priority' ELSE '[]'::jsonb END
        ), 0) = 0
    AND COALESCE(jsonb_array_length(
          CASE WHEN jsonb_typeof(catalog.catalog->'dropdowns'->'status') = 'array'
            THEN catalog.catalog->'dropdowns'->'status' ELSE '[]'::jsonb END
        ), 0) = 0
    AND COALESCE(jsonb_array_length(
          CASE WHEN jsonb_typeof(catalog.catalog->'dropdowns'->'source') = 'array'
            THEN catalog.catalog->'dropdowns'->'source' ELSE '[]'::jsonb END
        ), 0) = 0
    AND COALESCE(jsonb_array_length(
          CASE WHEN jsonb_typeof(catalog.catalog->'dropdowns'->'loss_reason') = 'array'
            THEN catalog.catalog->'dropdowns'->'loss_reason' ELSE '[]'::jsonb END
        ), 0) = 0
)
UPDATE pipeline_dropdown_catalogs catalog
SET catalog = jsonb_set(
      catalog.catalog,
      '{dropdowns}',
      COALESCE(catalog.catalog->'dropdowns', '{}'::jsonb) || base_dropdowns.value,
      true
    ),
    source = 'app',
    desired_revision = catalog.desired_revision + 1,
    updated_at = now()
FROM empty_catalogs, base_dropdowns
WHERE catalog.pipeline_id = empty_catalogs.pipeline_id;
