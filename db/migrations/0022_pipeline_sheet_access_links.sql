WITH candidates AS (
  SELECT
    pipeline.id AS pipeline_id,
    pipeline.owner_email,
    pipeline.name,
    'https://docs.google.com/spreadsheets/d/' || pipeline.sheet_id || '/edit' AS destination_url,
    'pipeline-' || left(md5(pipeline.id::text), 12) AS slug
  FROM pipeline_spaces pipeline
  WHERE pipeline.provisioning_status = 'ready'
    AND pipeline.sync_enabled = true
    AND pipeline.sheet_id IS NOT NULL
    AND pipeline.short_link_id IS NULL
),
created_links AS (
  INSERT INTO short_links (
    owner_email,
    source_app,
    slug,
    destination_url,
    title,
    tags
  )
  SELECT
    candidate.owner_email,
    'clawpilot',
    candidate.slug,
    candidate.destination_url,
    candidate.name || ' pipeline',
    ARRAY['pipeline', 'google-sheet']::text[]
  FROM candidates candidate
  WHERE NOT EXISTS (
    SELECT 1
    FROM short_links link
    WHERE link.owner_email = candidate.owner_email
      AND link.source_app = 'clawpilot'
      AND link.destination_url = candidate.destination_url
      AND link.deleted_at IS NULL
      AND link.disabled_at IS NULL
      AND (link.expires_at IS NULL OR link.expires_at > now())
      AND (link.max_clicks IS NULL OR link.click_count < link.max_clicks)
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id, owner_email, destination_url
),
available_links AS (
  SELECT candidate.pipeline_id, link.id AS short_link_id
  FROM candidates candidate
  JOIN LATERAL (
    SELECT existing.id
    FROM short_links existing
    WHERE existing.owner_email = candidate.owner_email
      AND existing.source_app = 'clawpilot'
      AND existing.destination_url = candidate.destination_url
      AND existing.deleted_at IS NULL
      AND existing.disabled_at IS NULL
      AND (existing.expires_at IS NULL OR existing.expires_at > now())
      AND (existing.max_clicks IS NULL OR existing.click_count < existing.max_clicks)
    ORDER BY existing.created_at, existing.id
    LIMIT 1
  ) link ON true
  UNION ALL
  SELECT candidate.pipeline_id, created.id AS short_link_id
  FROM candidates candidate
  JOIN created_links created
    ON created.owner_email = candidate.owner_email
   AND created.destination_url = candidate.destination_url
),
bound_links AS (
  UPDATE pipeline_spaces pipeline
  SET short_link_id = available.short_link_id,
      updated_at = now()
  FROM available_links available
  WHERE pipeline.id = available.pipeline_id
    AND pipeline.short_link_id IS NULL
  RETURNING pipeline.id, pipeline.owner_email, pipeline.short_link_id
)
INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
SELECT
  bound.owner_email,
  'pipeline.sheet_link.backfilled',
  'pipeline_space',
  bound.id::text,
  jsonb_build_object('shortLinkId', bound.short_link_id)
FROM bound_links bound;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pipeline_spaces
    WHERE provisioning_status = 'ready'
      AND sync_enabled = true
      AND sheet_id IS NOT NULL
      AND short_link_id IS NULL
  ) THEN
    RAISE EXCEPTION 'A ready pipeline is missing its Sheet short link';
  END IF;
END
$$;
