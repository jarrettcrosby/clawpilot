-- Read-only SuiteCRM -> ClawPilot Product-image observations.
--
-- SuiteCRM is not granted any provider authority by this migration. The
-- ingestion runtime may only read AOS Products and their private media, then
-- persist immutable app-owned evidence. In particular, no commerce effect,
-- sync outbox row, or provider write is created from these tables.

ALTER TABLE crm_product_image_assets
  DROP CONSTRAINT IF EXISTS crm_product_image_assets_source_valid;

ALTER TABLE crm_product_image_assets
  ADD CONSTRAINT crm_product_image_assets_source_valid CHECK (
    source IN (
      'manual_upload',
      'provider_import',
      'suitecrm_import',
      'migration'
    )
  );

INSERT INTO global_reference_entity_types (
  prefix, entity_type, display_name
)
VALUES
  (
    'gsio',
    'crm.suitecrm_product_image_observation',
    'SuiteCRM Product image observation'
  ),
  (
    'gsip',
    'crm.suitecrm_product_image_provenance',
    'SuiteCRM Product image provenance'
  )
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE crm_suitecrm_product_image_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gsio'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid,
  product_id uuid,
  suitecrm_id text NOT NULL,
  suitecrm_global_id text,
  suitecrm_modified_at timestamptz NOT NULL,
  correlation_state text NOT NULL CHECK (
    correlation_state IN ('exact', 'identity_conflict')
  ),
  media_state text NOT NULL CHECK (media_state IN ('present', 'absent')),
  media_id uuid,
  original_name text,
  mime_type text,
  content_sha256 text,
  byte_length integer,
  pixel_width integer,
  pixel_height integer,
  snapshot_sha256 text NOT NULL,
  observation_revision bigint NOT NULL CHECK (observation_revision >= 1),
  local_primary_asset_id uuid,
  local_primary_asset_revision bigint,
  local_primary_row_version bigint,
  local_primary_content_sha256 text,
  observed_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  observed_at timestamptz NOT NULL,
  provider_write_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT crm_suitecrm_product_image_observation_global_valid CHECK (
    global_id ~ '^gsio[0-9a-v]{12}$'
  ),
  CONSTRAINT crm_suitecrm_product_image_observation_provider_writes_zero
    CHECK (provider_write_count = 0),
  CONSTRAINT crm_suitecrm_product_image_observation_global_unique
    UNIQUE (global_id),
  CONSTRAINT crm_suitecrm_product_image_observation_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT crm_suitecrm_product_image_observation_pipeline_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT crm_suitecrm_product_image_observation_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_suitecrm_product_image_observation_primary_asset_fkey
    FOREIGN KEY (
      organization_id,
      pipeline_id,
      product_id,
      local_primary_asset_id
    ) REFERENCES crm_product_image_assets (
      organization_id,
      pipeline_id,
      product_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT crm_suitecrm_product_image_observation_identity_valid CHECK (
    suitecrm_id = btrim(suitecrm_id)
    AND length(suitecrm_id) BETWEEN 1 AND 100
    AND suitecrm_id !~ '[[:cntrl:]]'
    AND (
      suitecrm_global_id IS NULL
      OR suitecrm_global_id ~ '^gp(?:[0-9]{7}|[0-9a-v]{12})$'
    )
  ),
  CONSTRAINT crm_suitecrm_product_image_observation_correlation_valid CHECK (
    (
      correlation_state = 'exact'
      AND pipeline_id IS NOT NULL
      AND product_id IS NOT NULL
      AND suitecrm_global_id IS NOT NULL
    )
    OR (
      correlation_state = 'identity_conflict'
      AND pipeline_id IS NULL
      AND product_id IS NULL
    )
  ),
  CONSTRAINT crm_suitecrm_product_image_observation_media_valid CHECK (
    (
      media_state = 'absent'
      AND media_id IS NULL
      AND original_name IS NULL
      AND mime_type IS NULL
      AND content_sha256 IS NULL
      AND byte_length IS NULL
      AND pixel_width IS NULL
      AND pixel_height IS NULL
    )
    OR (
      media_state = 'present'
      AND media_id IS NOT NULL
      AND original_name IS NOT NULL
      AND length(btrim(original_name)) BETWEEN 1 AND 512
      AND original_name !~ '[[:cntrl:]]'
      AND mime_type IS NOT NULL
      AND mime_type IN ('image/png', 'image/jpeg', 'image/webp')
      AND content_sha256 IS NOT NULL
      AND content_sha256 ~ '^[0-9a-f]{64}$'
      AND byte_length IS NOT NULL
      AND byte_length BETWEEN 1 AND 2097152
      AND pixel_width IS NOT NULL
      AND pixel_width BETWEEN 1 AND 8192
      AND pixel_height IS NOT NULL
      AND pixel_height BETWEEN 1 AND 8192
      AND pixel_width::bigint * pixel_height::bigint <= 40000000
    )
  ),
  CONSTRAINT crm_suitecrm_product_image_observation_snapshot_valid CHECK (
    snapshot_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT crm_suitecrm_product_image_observation_timestamp_valid CHECK (
    suitecrm_modified_at <= observed_at + interval '5 minutes'
  ),
  CONSTRAINT crm_suitecrm_product_image_observation_primary_valid CHECK (
    (
      local_primary_asset_id IS NULL
      AND local_primary_asset_revision IS NULL
      AND local_primary_row_version IS NULL
      AND local_primary_content_sha256 IS NULL
    )
    OR (
      correlation_state = 'exact'
      AND local_primary_asset_id IS NOT NULL
      AND local_primary_asset_revision IS NOT NULL
      AND local_primary_asset_revision >= 1
      AND local_primary_row_version IS NOT NULL
      AND local_primary_row_version >= 1
      AND local_primary_content_sha256 IS NOT NULL
      AND local_primary_content_sha256 ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT crm_suitecrm_product_image_observation_scoped_id_unique
    UNIQUE (organization_id, suitecrm_id, id),
  CONSTRAINT crm_suitecrm_product_image_observation_revision_unique
    UNIQUE (organization_id, suitecrm_id, observation_revision),
  CONSTRAINT crm_suitecrm_product_image_observation_replay_unique UNIQUE (
    organization_id,
    suitecrm_id,
    suitecrm_modified_at,
    snapshot_sha256
  )
);

CREATE INDEX crm_suitecrm_product_image_observation_product_idx
  ON crm_suitecrm_product_image_observations (
    organization_id,
    pipeline_id,
    product_id,
    suitecrm_modified_at DESC,
    observation_revision DESC
  )
  WHERE product_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_crm_suitecrm_product_image_observation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'SuiteCRM Product image observations are immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.app_user_organization_memberships membership
    WHERE membership.user_email = NEW.observed_by
      AND membership.organization_id = NEW.organization_id
      AND membership.status = 'active'
  ) THEN
    RAISE EXCEPTION
      'SuiteCRM Product image observer requires active organization membership';
  END IF;
  IF NEW.correlation_state = 'exact' AND NOT EXISTS (
    SELECT 1
    FROM public.crm_products product
    JOIN public.pipeline_spaces pipeline
      ON pipeline.id = product.pipeline_id
     AND pipeline.workspace_organization_id = NEW.organization_id
    WHERE product.pipeline_id = NEW.pipeline_id
      AND product.id = NEW.product_id
      AND product.suitecrm_id = NEW.suitecrm_id
      AND product.reference_code = NEW.suitecrm_global_id
  ) THEN
    RAISE EXCEPTION
      'SuiteCRM Product image exact correlation does not match the Product identity';
  END IF;
  IF NEW.local_primary_asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.crm_product_image_assets asset
    WHERE asset.organization_id = NEW.organization_id
      AND asset.pipeline_id = NEW.pipeline_id
      AND asset.product_id = NEW.product_id
      AND asset.id = NEW.local_primary_asset_id
      AND asset.asset_revision = NEW.local_primary_asset_revision
      AND asset.row_version = NEW.local_primary_row_version
      AND asset.content_sha256 = NEW.local_primary_content_sha256
      AND asset.is_primary = true
  ) THEN
    RAISE EXCEPTION
      'SuiteCRM Product image observation primary evidence is not exact';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_crm_suitecrm_product_image_observation_write
BEFORE INSERT OR UPDATE OR DELETE
ON crm_suitecrm_product_image_observations
FOR EACH ROW EXECUTE FUNCTION
  guard_crm_suitecrm_product_image_observation();

CREATE TABLE crm_suitecrm_product_image_snapshot_fences (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  suitecrm_id text NOT NULL,
  pipeline_id uuid,
  product_id uuid,
  accepted_suitecrm_modified_at timestamptz NOT NULL,
  accepted_snapshot_sha256 text NOT NULL,
  accepted_observation_id uuid NOT NULL,
  fence_revision bigint NOT NULL CHECK (fence_revision >= 1),
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  updated_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT crm_suitecrm_product_image_snapshot_fence_pkey PRIMARY KEY (
    organization_id,
    suitecrm_id
  ),
  CONSTRAINT crm_suitecrm_product_image_snapshot_fence_pipeline_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT crm_suitecrm_product_image_snapshot_fence_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_suitecrm_product_image_snapshot_fence_observation_fkey
    FOREIGN KEY (
      organization_id,
      suitecrm_id,
      accepted_observation_id
    ) REFERENCES crm_suitecrm_product_image_observations (
      organization_id,
      suitecrm_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT crm_suitecrm_product_image_snapshot_fence_identity_valid CHECK (
    suitecrm_id = btrim(suitecrm_id)
    AND length(suitecrm_id) BETWEEN 1 AND 100
    AND suitecrm_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT crm_suitecrm_product_image_snapshot_fence_hash_valid CHECK (
    accepted_snapshot_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT crm_suitecrm_product_image_snapshot_fence_product_valid CHECK (
    (pipeline_id IS NULL) = (product_id IS NULL)
  )
);

CREATE OR REPLACE FUNCTION guard_crm_suitecrm_product_image_snapshot_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SuiteCRM Product image snapshot fences cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.organization_id, NEW.suitecrm_id) IS DISTINCT FROM
       (OLD.organization_id, OLD.suitecrm_id) THEN
      RAISE EXCEPTION 'SuiteCRM Product image snapshot fence scope is immutable';
    END IF;
    IF OLD.product_id IS NOT NULL AND
       (NEW.pipeline_id, NEW.product_id) IS DISTINCT FROM
       (OLD.pipeline_id, OLD.product_id) THEN
      RAISE EXCEPTION 'SuiteCRM Product image exact correlation cannot change';
    END IF;
    IF NEW.accepted_suitecrm_modified_at <
       OLD.accepted_suitecrm_modified_at THEN
      RAISE EXCEPTION 'SuiteCRM Product image snapshot fence cannot regress';
    END IF;
    IF NEW.accepted_suitecrm_modified_at =
       OLD.accepted_suitecrm_modified_at AND
       NEW.accepted_snapshot_sha256 <>
       OLD.accepted_snapshot_sha256 THEN
      RAISE EXCEPTION
        'SuiteCRM Product image timestamp cannot identify different evidence';
    END IF;
    IF NEW.fence_revision <> OLD.fence_revision + 1 THEN
      RAISE EXCEPTION 'SuiteCRM Product image fence revision must advance by one';
    END IF;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    NEW.updated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_crm_suitecrm_product_image_snapshot_fence_write
BEFORE INSERT OR UPDATE OR DELETE
ON crm_suitecrm_product_image_snapshot_fences
FOR EACH ROW EXECUTE FUNCTION
  guard_crm_suitecrm_product_image_snapshot_fence();

CREATE TABLE crm_suitecrm_product_image_asset_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gsip'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  suitecrm_id text NOT NULL,
  observation_id uuid NOT NULL,
  pipeline_id uuid,
  product_id uuid,
  resolution text NOT NULL CHECK (resolution IN (
    'echo_suppressed',
    'imported_primary',
    'imported_secondary',
    'identity_conflict',
    'media_integrity_conflict',
    'no_image'
  )),
  conflict_reason text,
  local_primary_before_asset_id uuid,
  local_primary_before_revision bigint,
  local_primary_before_row_version bigint,
  local_primary_before_content_sha256 text,
  result_asset_id uuid,
  result_asset_revision bigint,
  result_asset_content_sha256 text,
  promoted_to_primary boolean NOT NULL DEFAULT false,
  provider_write_count integer NOT NULL DEFAULT 0,
  imported_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT crm_suitecrm_product_image_provenance_global_valid CHECK (
    global_id ~ '^gsip[0-9a-v]{12}$'
  ),
  CONSTRAINT crm_suitecrm_product_image_provenance_provider_writes_zero
    CHECK (provider_write_count = 0),
  CONSTRAINT crm_suitecrm_product_image_provenance_global_unique
    UNIQUE (global_id),
  CONSTRAINT crm_suitecrm_product_image_provenance_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT crm_suitecrm_product_image_provenance_observation_fkey
    FOREIGN KEY (organization_id, suitecrm_id, observation_id)
    REFERENCES crm_suitecrm_product_image_observations (
      organization_id,
      suitecrm_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT crm_suitecrm_product_image_provenance_pipeline_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT crm_suitecrm_product_image_provenance_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_suitecrm_product_image_provenance_primary_before_fkey
    FOREIGN KEY (
      organization_id,
      pipeline_id,
      product_id,
      local_primary_before_asset_id
    ) REFERENCES crm_product_image_assets (
      organization_id,
      pipeline_id,
      product_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT crm_suitecrm_product_image_provenance_result_asset_fkey
    FOREIGN KEY (
      organization_id,
      pipeline_id,
      product_id,
      result_asset_id
    ) REFERENCES crm_product_image_assets (
      organization_id,
      pipeline_id,
      product_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT crm_suitecrm_product_image_provenance_scope_valid CHECK (
    (
      resolution = 'identity_conflict'
      AND pipeline_id IS NULL
      AND product_id IS NULL
      AND result_asset_id IS NULL
    )
    OR (
      resolution <> 'identity_conflict'
      AND pipeline_id IS NOT NULL
      AND product_id IS NOT NULL
    )
  ),
  CONSTRAINT crm_suitecrm_product_image_provenance_primary_before_valid CHECK (
    (
      local_primary_before_asset_id IS NULL
      AND local_primary_before_revision IS NULL
      AND local_primary_before_row_version IS NULL
      AND local_primary_before_content_sha256 IS NULL
    )
    OR (
      local_primary_before_asset_id IS NOT NULL
      AND local_primary_before_revision IS NOT NULL
      AND local_primary_before_revision >= 1
      AND local_primary_before_row_version IS NOT NULL
      AND local_primary_before_row_version >= 1
      AND local_primary_before_content_sha256 IS NOT NULL
      AND local_primary_before_content_sha256 ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT crm_suitecrm_product_image_provenance_result_valid CHECK (
    (
      result_asset_id IS NULL
      AND result_asset_revision IS NULL
      AND result_asset_content_sha256 IS NULL
    )
    OR (
      result_asset_id IS NOT NULL
      AND result_asset_revision IS NOT NULL
      AND result_asset_revision >= 1
      AND result_asset_content_sha256 IS NOT NULL
      AND result_asset_content_sha256 ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT crm_suitecrm_product_image_provenance_resolution_valid CHECK (
    (promoted_to_primary = true) = (resolution = 'imported_primary')
    AND (conflict_reason IS NULL OR (
      length(btrim(conflict_reason)) BETWEEN 1 AND 200
      AND conflict_reason !~ '[[:cntrl:]]'
    ))
    AND (
      resolution IN ('identity_conflict', 'media_integrity_conflict',
        'imported_secondary')
      OR conflict_reason IS NULL
    )
    AND (
      (
        resolution IN ('echo_suppressed', 'imported_primary',
          'imported_secondary')
        AND result_asset_id IS NOT NULL
      )
      OR (
        resolution NOT IN ('echo_suppressed', 'imported_primary',
          'imported_secondary')
        AND result_asset_id IS NULL
      )
    )
  ),
  CONSTRAINT crm_suitecrm_product_image_provenance_observation_unique
    UNIQUE (observation_id)
);

CREATE INDEX crm_suitecrm_product_image_provenance_review_idx
  ON crm_suitecrm_product_image_asset_provenance (
    organization_id,
    resolution,
    imported_at DESC
  )
  WHERE resolution IN (
    'identity_conflict',
    'media_integrity_conflict',
    'imported_secondary'
  );

CREATE OR REPLACE FUNCTION guard_crm_suitecrm_product_image_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  observation_row public.crm_suitecrm_product_image_observations%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'SuiteCRM Product image provenance is immutable';
  END IF;
  SELECT observation.* INTO STRICT observation_row
  FROM public.crm_suitecrm_product_image_observations observation
  WHERE observation.organization_id = NEW.organization_id
    AND observation.suitecrm_id = NEW.suitecrm_id
    AND observation.id = NEW.observation_id;
  IF (NEW.pipeline_id, NEW.product_id) IS DISTINCT FROM
     (observation_row.pipeline_id, observation_row.product_id)
     OR (
       NEW.local_primary_before_asset_id,
       NEW.local_primary_before_revision,
       NEW.local_primary_before_row_version,
       NEW.local_primary_before_content_sha256
     ) IS DISTINCT FROM (
       observation_row.local_primary_asset_id,
       observation_row.local_primary_asset_revision,
       observation_row.local_primary_row_version,
       observation_row.local_primary_content_sha256
     ) THEN
    RAISE EXCEPTION
      'SuiteCRM Product image provenance does not match its observation lineage';
  END IF;
  IF NEW.imported_by <> observation_row.observed_by OR NOT EXISTS (
    SELECT 1
    FROM public.app_user_organization_memberships membership
    WHERE membership.user_email = NEW.imported_by
      AND membership.organization_id = NEW.organization_id
      AND membership.status = 'active'
  ) THEN
    RAISE EXCEPTION
      'SuiteCRM Product image provenance actor lacks exact organization authority';
  END IF;
  IF (
    observation_row.correlation_state = 'identity_conflict'
    AND NEW.resolution <> 'identity_conflict'
  ) OR (
    observation_row.correlation_state = 'exact'
    AND NEW.resolution = 'identity_conflict'
  ) OR (
    observation_row.correlation_state = 'exact'
    AND observation_row.media_state = 'absent'
    AND NEW.resolution <> 'no_image'
  ) OR (
    observation_row.correlation_state = 'exact'
    AND observation_row.media_state = 'present'
    AND NEW.resolution = 'no_image'
  ) THEN
    RAISE EXCEPTION
      'SuiteCRM Product image provenance resolution contradicts its observation';
  END IF;
  IF NEW.result_asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.crm_product_image_assets asset
    WHERE asset.organization_id = NEW.organization_id
      AND asset.pipeline_id = NEW.pipeline_id
      AND asset.product_id = NEW.product_id
      AND asset.id = NEW.result_asset_id
      AND asset.asset_revision = NEW.result_asset_revision
      AND asset.content_sha256 = NEW.result_asset_content_sha256
      AND asset.content_sha256 = observation_row.content_sha256
      AND (
        NEW.resolution <> 'imported_primary'
        OR asset.is_primary = true
      )
  ) THEN
    RAISE EXCEPTION
      'SuiteCRM Product image provenance result evidence is not exact';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_crm_suitecrm_product_image_provenance_write
BEFORE INSERT OR UPDATE OR DELETE
ON crm_suitecrm_product_image_asset_provenance
FOR EACH ROW EXECUTE FUNCTION
  guard_crm_suitecrm_product_image_provenance();

ALTER TABLE crm_suitecrm_product_image_snapshot_fences
  ADD CONSTRAINT crm_suitecrm_product_image_snapshot_fence_provenance_fkey
  FOREIGN KEY (accepted_observation_id)
  REFERENCES crm_suitecrm_product_image_asset_provenance(observation_id)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION guard_crm_suitecrm_product_image_snapshot_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  observation_row public.crm_suitecrm_product_image_observations%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SuiteCRM Product image snapshot fences cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.organization_id, NEW.suitecrm_id) IS DISTINCT FROM
       (OLD.organization_id, OLD.suitecrm_id) THEN
      RAISE EXCEPTION 'SuiteCRM Product image snapshot fence scope is immutable';
    END IF;
    IF OLD.product_id IS NOT NULL AND
       (NEW.pipeline_id, NEW.product_id) IS DISTINCT FROM
       (OLD.pipeline_id, OLD.product_id) THEN
      RAISE EXCEPTION 'SuiteCRM Product image exact correlation cannot change';
    END IF;
    IF NEW.accepted_suitecrm_modified_at <
       OLD.accepted_suitecrm_modified_at THEN
      RAISE EXCEPTION 'SuiteCRM Product image snapshot fence cannot regress';
    END IF;
    IF NEW.accepted_suitecrm_modified_at =
       OLD.accepted_suitecrm_modified_at AND
       NEW.accepted_snapshot_sha256 <>
       OLD.accepted_snapshot_sha256 THEN
      RAISE EXCEPTION
        'SuiteCRM Product image timestamp cannot identify different evidence';
    END IF;
    IF NEW.fence_revision <> OLD.fence_revision + 1 THEN
      RAISE EXCEPTION 'SuiteCRM Product image fence revision must advance by one';
    END IF;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    NEW.updated_at := clock_timestamp();
  END IF;
  SELECT observation.* INTO STRICT observation_row
  FROM public.crm_suitecrm_product_image_observations observation
  WHERE observation.organization_id = NEW.organization_id
    AND observation.suitecrm_id = NEW.suitecrm_id
    AND observation.id = NEW.accepted_observation_id;
  IF (NEW.pipeline_id, NEW.product_id) IS DISTINCT FROM
     (observation_row.pipeline_id, observation_row.product_id)
     OR NEW.accepted_suitecrm_modified_at IS DISTINCT FROM
        observation_row.suitecrm_modified_at
     OR NEW.accepted_snapshot_sha256 IS DISTINCT FROM
        observation_row.snapshot_sha256
     OR NEW.fence_revision IS DISTINCT FROM
        observation_row.observation_revision THEN
    RAISE EXCEPTION
      'SuiteCRM Product image snapshot fence does not match exact observation evidence';
  END IF;
  IF (
       TG_OP = 'INSERT'
       AND NEW.created_by <> observation_row.observed_by
     )
     OR NEW.updated_by <> observation_row.observed_by
     OR NOT EXISTS (
       SELECT 1
       FROM public.app_user_organization_memberships membership
       WHERE membership.user_email = observation_row.observed_by
         AND membership.organization_id = NEW.organization_id
         AND membership.status = 'active'
     ) THEN
    RAISE EXCEPTION
      'SuiteCRM Product image snapshot fence actor lacks exact organization authority';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  guard_crm_suitecrm_image_fence_initial_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.fence_revision <> 1 THEN
    RAISE EXCEPTION
      'SuiteCRM Product image snapshot fence must begin at revision one';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER
  guard_crm_suitecrm_image_fence_initial_revision_write
AFTER INSERT
ON crm_suitecrm_product_image_snapshot_fences
FOR EACH ROW EXECUTE FUNCTION
  guard_crm_suitecrm_image_fence_initial_revision();

CREATE TABLE crm_suitecrm_product_image_ingestion_worker_heartbeat (
  worker_name text PRIMARY KEY CHECK (
    worker_name = 'suitecrm-product-image-ingestion'
  ),
  checked_at timestamptz NOT NULL,
  phase text NOT NULL CHECK (
    phase IN ('starting', 'completed', 'degraded', 'disabled')
  ),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(details) = 'object'
  )
);
