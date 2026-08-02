-- Durable, provider-read-only image import state for Shopify and Faire.
--
-- Provider locators are represented only by SHA-256 fingerprints. Raw URLs,
-- provider payloads, image bytes, credentials, and provider-write counters do
-- not belong in this ledger. Validated image bytes remain in the existing
-- app-owned crm_product_image_assets table.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('gcis', 'operations.commerce_product_image_observation_set',
    'Commerce product image observation set'),
  ('gcio', 'operations.commerce_product_image_observation',
    'Commerce product image observation'),
  ('gcij', 'operations.commerce_product_image_import_job',
    'Commerce product image import job'),
  ('gcip', 'operations.commerce_product_image_asset_provenance',
    'Commerce product image asset provenance'),
  ('gcib', 'operations.commerce_product_image_binding',
    'Commerce product image binding')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE OR REPLACE FUNCTION
  operations_commerce_product_image_account_is_current(
    requested_organization_id uuid,
    requested_integration_account_id uuid,
    requested_provider text,
    requested_credential_generation integer
  )
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.operations_integration_accounts account
    JOIN public.operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
     AND credential.external_account_id = account.external_account_id
    JOIN public.operations_activation_scopes activation
      ON activation.organization_id = account.organization_id
    WHERE account.organization_id = requested_organization_id
      AND account.id = requested_integration_account_id
      AND account.integration_type = 'commerce'
      AND account.provider = requested_provider
      AND account.status = 'active'
      AND account.commerce_credential_generation =
            requested_credential_generation
      AND requested_credential_generation > 0
      AND credential.credential_version =
            account.commerce_credential_generation
      AND credential.verification_status = 'verified'
      AND activation.state IN ('shadow', 'active')
  )
$$;

-- A provider product may legitimately have several variant mappings. It is
-- unambiguous when every exact, active variant mapping resolves to the same
-- ClawPilot Product. The fingerprint fences the complete mapping set, rather
-- than selecting one variant and silently ignoring its siblings.
CREATE OR REPLACE FUNCTION
  operations_commerce_product_image_mapping_resolution(
    requested_organization_id uuid,
    requested_integration_account_id uuid,
    requested_provider text,
    requested_external_product_id text
  )
RETURNS TABLE (
  resolution_count integer,
  pipeline_id uuid,
  product_id uuid,
  canonical_product_mapping_id uuid,
  mapping_count integer,
  mapping_fingerprint_sha256 text,
  activation_revision integer,
  product_name text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH exact_mapping AS (
    SELECT DISTINCT
      mapping.id,
      mapping.pipeline_id,
      mapping.product_id,
      mapping.external_product_id,
      mapping.external_variant_id,
      mapping.mapping_method,
      activation.revision AS activation_revision,
      product.name AS product_name
    FROM public.operations_product_channel_states channel_state
    JOIN public.operations_product_mappings mapping
      ON mapping.organization_id = channel_state.organization_id
     AND mapping.integration_account_id =
           channel_state.integration_account_id
     AND mapping.pipeline_id = channel_state.pipeline_id
     AND mapping.id = channel_state.product_mapping_id
     AND mapping.product_id = channel_state.product_id
     AND mapping.active = true
    JOIN public.crm_products product
      ON product.pipeline_id = mapping.pipeline_id
     AND product.id = mapping.product_id
    JOIN public.operations_activation_scopes activation
      ON activation.organization_id = mapping.organization_id
     AND activation.data_pipeline_id = mapping.pipeline_id
     AND activation.state IN ('shadow', 'active')
    WHERE channel_state.organization_id = requested_organization_id
      AND channel_state.integration_account_id =
            requested_integration_account_id
      AND channel_state.provider = requested_provider
      AND channel_state.external_product_id =
            requested_external_product_id
      AND channel_state.product_id IS NOT NULL
      AND channel_state.product_mapping_id IS NOT NULL
  ),
  candidate AS (
    SELECT
      exact_mapping.pipeline_id,
      exact_mapping.product_id,
      exact_mapping.activation_revision,
      (min(exact_mapping.id::text))::uuid AS canonical_mapping_id,
      count(*)::integer AS exact_mapping_count,
      encode(
        digest(
          convert_to(
            string_agg(
              concat_ws(
                chr(31),
                exact_mapping.id::text,
                exact_mapping.pipeline_id::text,
                exact_mapping.product_id::text,
                COALESCE(exact_mapping.external_product_id, ''),
                COALESCE(exact_mapping.external_variant_id, ''),
                exact_mapping.mapping_method
              ),
              chr(30) ORDER BY exact_mapping.id::text
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) AS mapping_hash,
      min(exact_mapping.product_name) AS resolved_product_name
    FROM exact_mapping
    GROUP BY
      exact_mapping.pipeline_id,
      exact_mapping.product_id,
      exact_mapping.activation_revision
  ),
  resolution AS (
    SELECT count(*)::integer AS candidate_count
    FROM candidate
  )
  SELECT
    resolution.candidate_count,
    CASE WHEN resolution.candidate_count = 1
      THEN candidate.pipeline_id ELSE NULL END,
    CASE WHEN resolution.candidate_count = 1
      THEN candidate.product_id ELSE NULL END,
    CASE WHEN resolution.candidate_count = 1
      THEN candidate.canonical_mapping_id ELSE NULL END,
    CASE WHEN resolution.candidate_count = 1
      THEN candidate.exact_mapping_count ELSE NULL END,
    CASE WHEN resolution.candidate_count = 1
      THEN candidate.mapping_hash ELSE NULL END,
    CASE WHEN resolution.candidate_count = 1
      THEN candidate.activation_revision ELSE NULL END,
    CASE WHEN resolution.candidate_count = 1
      THEN candidate.resolved_product_name ELSE NULL END
  FROM resolution
  LEFT JOIN candidate ON resolution.candidate_count = 1
$$;

-- One mutable monotonic cursor per credential-scoped provider product prevents
-- a delayed, older read from undoing a newer product-image reconciliation. The
-- cursor stores fingerprints only; immutable snapshot evidence lives in the
-- observation-set table below.
CREATE TABLE operations_commerce_product_image_snapshot_fences (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  external_product_id text NOT NULL,
  accepted_observed_at timestamptz NOT NULL,
  accepted_snapshot_sha256 text NOT NULL,
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  updated_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ops_commerce_image_snapshot_fence_pkey PRIMARY KEY (
    organization_id,
    integration_account_id,
    provider,
    credential_generation,
    external_product_id
  ),
  CONSTRAINT ops_commerce_image_snapshot_fence_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_snapshot_fence_product_id_valid CHECK (
    external_product_id = btrim(external_product_id)
    AND length(external_product_id) BETWEEN 1 AND 512
    AND external_product_id !~ '[[:cntrl:]]'
    AND external_product_id !~* 'https?://'
  ),
  CONSTRAINT ops_commerce_image_snapshot_fence_hash_valid CHECK (
    accepted_snapshot_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE OR REPLACE FUNCTION
  guard_operations_commerce_product_image_snapshot_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Commerce product image snapshot fences cannot be deleted';
  END IF;
  IF NOT public.operations_commerce_product_image_account_is_current(
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.provider,
    NEW.credential_generation
  ) THEN
    RAISE EXCEPTION
      'Commerce product image snapshot fence requires the current verified account credential';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (
      NEW.organization_id,
      NEW.integration_account_id,
      NEW.provider,
      NEW.credential_generation,
      NEW.external_product_id
    ) IS DISTINCT FROM (
      OLD.organization_id,
      OLD.integration_account_id,
      OLD.provider,
      OLD.credential_generation,
      OLD.external_product_id
    ) THEN
      RAISE EXCEPTION 'Commerce product image snapshot fence scope is immutable';
    END IF;
    IF NEW.accepted_observed_at < OLD.accepted_observed_at THEN
      RAISE EXCEPTION 'Commerce product image snapshot fence cannot regress';
    END IF;
    IF NEW.accepted_observed_at = OLD.accepted_observed_at
      AND NEW.accepted_snapshot_sha256 <> OLD.accepted_snapshot_sha256 THEN
      RAISE EXCEPTION
        'Commerce product image snapshot timestamp cannot identify different evidence';
    END IF;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    NEW.updated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_operations_commerce_product_image_snapshot_fence_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_commerce_product_image_snapshot_fences
FOR EACH ROW EXECUTE FUNCTION
  guard_operations_commerce_product_image_snapshot_fence();

CREATE TABLE operations_commerce_product_image_observation_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcis'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  external_product_id text NOT NULL,
  product_source_hash text NOT NULL,
  image_set_complete boolean NOT NULL,
  image_identity_count integer NOT NULL
    CHECK (image_identity_count BETWEEN 0 AND 500),
  image_identity_set_sha256 text NOT NULL,
  snapshot_sha256 text NOT NULL,
  provider_updated_at timestamptz,
  observed_at timestamptz NOT NULL,
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ops_commerce_image_set_global_valid
    CHECK (global_id ~ '^gcis[0-9a-v]{12}$'),
  CONSTRAINT ops_commerce_image_set_global_unique UNIQUE (global_id),
  CONSTRAINT ops_commerce_image_set_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_set_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_set_product_id_valid CHECK (
    external_product_id = btrim(external_product_id)
    AND length(external_product_id) BETWEEN 1 AND 512
    AND external_product_id !~ '[[:cntrl:]]'
    AND external_product_id !~* 'https?://'
  ),
  CONSTRAINT ops_commerce_image_set_hashes_valid CHECK (
    product_source_hash ~ '^[0-9a-f]{64}$'
    AND image_identity_set_sha256 ~ '^[0-9a-f]{64}$'
    AND snapshot_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ops_commerce_image_set_scoped_id_unique UNIQUE (
    organization_id, integration_account_id, id
  ),
  CONSTRAINT ops_commerce_image_set_exact_scope_unique UNIQUE (
    organization_id,
    integration_account_id,
    provider,
    credential_generation,
    external_product_id,
    id
  ),
  CONSTRAINT ops_commerce_image_set_replay_unique UNIQUE (
    organization_id,
    integration_account_id,
    provider,
    credential_generation,
    external_product_id,
    observed_at,
    product_source_hash,
    image_set_complete,
    image_identity_set_sha256,
    snapshot_sha256
  )
);

CREATE INDEX ops_commerce_image_set_product_source_idx
  ON operations_commerce_product_image_observation_sets (
    organization_id,
    integration_account_id,
    credential_generation,
    external_product_id,
    observed_at DESC
  );

CREATE OR REPLACE FUNCTION
  guard_operations_commerce_product_image_observation_set()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Commerce product image observation sets are immutable';
  END IF;
  IF NOT public.operations_commerce_product_image_account_is_current(
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.provider,
    NEW.credential_generation
  ) THEN
    RAISE EXCEPTION
      'Commerce product image observation set requires the current verified account credential';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_operations_commerce_product_image_observation_set_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_commerce_product_image_observation_sets
FOR EACH ROW EXECUTE FUNCTION
  guard_operations_commerce_product_image_observation_set();

CREATE TABLE operations_commerce_product_image_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcio'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  observation_set_id uuid NOT NULL,
  external_product_id text NOT NULL,
  provider_image_id text,
  locator_sha256 text NOT NULL,
  image_identity_sha256 text NOT NULL,
  image_sequence integer NOT NULL CHECK (image_sequence BETWEEN 0 AND 10000),
  alt_text text,
  pixel_width integer,
  pixel_height integer,
  lifecycle_state text NOT NULL
    CHECK (lifecycle_state IN ('active', 'removed')),
  source_hash text NOT NULL,
  observation_revision bigint NOT NULL DEFAULT 0
    CHECK (observation_revision >= 1),
  provider_updated_at timestamptz,
  observed_at timestamptz NOT NULL,
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ops_commerce_image_observation_global_valid
    CHECK (global_id ~ '^gcio[0-9a-v]{12}$'),
  CONSTRAINT ops_commerce_image_observation_global_unique UNIQUE (global_id),
  CONSTRAINT ops_commerce_image_observation_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_observation_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_observation_set_fkey
    FOREIGN KEY (
      organization_id,
      integration_account_id,
      provider,
      credential_generation,
      external_product_id,
      observation_set_id
    )
    REFERENCES operations_commerce_product_image_observation_sets (
      organization_id,
      integration_account_id,
      provider,
      credential_generation,
      external_product_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_observation_product_id_valid CHECK (
    external_product_id = btrim(external_product_id)
    AND length(external_product_id) BETWEEN 1 AND 512
    AND external_product_id !~ '[[:cntrl:]]'
    AND external_product_id !~* 'https?://'
  ),
  CONSTRAINT ops_commerce_image_observation_provider_image_id_valid CHECK (
    provider_image_id IS NULL
    OR (
      provider_image_id = btrim(provider_image_id)
      AND length(provider_image_id) BETWEEN 1 AND 512
      AND provider_image_id !~ '[[:cntrl:]]'
      AND provider_image_id !~* 'https?://'
    )
  ),
  CONSTRAINT ops_commerce_image_observation_hashes_valid CHECK (
    locator_sha256 ~ '^[0-9a-f]{64}$'
    AND image_identity_sha256 ~ '^[0-9a-f]{64}$'
    AND source_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ops_commerce_image_observation_alt_valid CHECK (
    alt_text IS NULL
    OR (
      length(btrim(alt_text)) BETWEEN 1 AND 500
      AND alt_text !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT ops_commerce_image_observation_dimensions_valid CHECK (
    (pixel_width IS NULL AND pixel_height IS NULL)
    OR (
      pixel_width BETWEEN 1 AND 8192
      AND pixel_height BETWEEN 1 AND 8192
      AND pixel_width::bigint * pixel_height::bigint <= 40000000
    )
  ),
  CONSTRAINT ops_commerce_image_observation_scoped_id_unique UNIQUE (
    organization_id, integration_account_id, id
  ),
  CONSTRAINT ops_commerce_image_observation_exact_fence_unique UNIQUE (
    organization_id,
    integration_account_id,
    provider,
    credential_generation,
    id,
    observation_revision,
    external_product_id,
    image_identity_sha256,
    locator_sha256,
    source_hash
  ),
  CONSTRAINT ops_commerce_image_observation_revision_unique UNIQUE (
    organization_id,
    integration_account_id,
    credential_generation,
    external_product_id,
    image_identity_sha256,
    observation_revision
  ),
  CONSTRAINT ops_commerce_image_observation_source_unique UNIQUE (
    organization_id,
    integration_account_id,
    credential_generation,
    external_product_id,
    image_identity_sha256,
    lifecycle_state,
    source_hash
  )
);

CREATE INDEX ops_commerce_image_observation_current_idx
  ON operations_commerce_product_image_observations (
    organization_id,
    integration_account_id,
    credential_generation,
    external_product_id,
    image_identity_sha256,
    observation_revision DESC
  );

CREATE OR REPLACE FUNCTION
  guard_operations_commerce_product_image_observation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_revision bigint;
  expected_identity text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Commerce product image observations are immutable';
  END IF;

  IF NOT public.operations_commerce_product_image_account_is_current(
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.provider,
    NEW.credential_generation
  ) THEN
    RAISE EXCEPTION
      'Commerce product image observation requires the current verified account credential';
  END IF;

  expected_identity := encode(
    digest(
      convert_to(
        CASE
          WHEN NEW.provider_image_id IS NOT NULL
            THEN 'provider-id:' || NEW.provider_image_id
          ELSE 'locator-sha256:' || NEW.locator_sha256
        END,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  IF NEW.image_identity_sha256 <> expected_identity THEN
    RAISE EXCEPTION
      'Commerce product image identity fingerprint is invalid';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(
      ':',
      'commerce-product-image-observation',
      NEW.organization_id::text,
      NEW.integration_account_id::text,
      NEW.credential_generation::text,
      NEW.external_product_id,
      NEW.image_identity_sha256
    ),
    0
  ));

  SELECT COALESCE(max(observation.observation_revision), 0) + 1
  INTO expected_revision
  FROM public.operations_commerce_product_image_observations observation
  WHERE observation.organization_id = NEW.organization_id
    AND observation.integration_account_id = NEW.integration_account_id
    AND observation.credential_generation = NEW.credential_generation
    AND observation.external_product_id = NEW.external_product_id
    AND observation.image_identity_sha256 = NEW.image_identity_sha256;

  NEW.observation_revision := expected_revision;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_operations_commerce_product_image_observation_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_commerce_product_image_observations
FOR EACH ROW EXECUTE FUNCTION
  guard_operations_commerce_product_image_observation();

-- Every snapshot records its exact member identities, even when an unchanged
-- image reuses an observation first captured by an older snapshot. This makes
-- the immutable observation-set count/hash reconstructable without copying
-- mutable provider payloads or raw locators.
CREATE TABLE operations_commerce_product_image_observation_set_memberships (
  organization_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  external_product_id text NOT NULL,
  observation_set_id uuid NOT NULL,
  image_identity_sha256 text NOT NULL,
  observation_id uuid NOT NULL,
  observation_revision bigint NOT NULL CHECK (observation_revision >= 1),
  locator_sha256 text NOT NULL,
  observation_source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ops_commerce_image_set_member_pkey PRIMARY KEY (
    organization_id,
    integration_account_id,
    observation_set_id,
    image_identity_sha256
  ),
  CONSTRAINT ops_commerce_image_set_member_set_fkey
    FOREIGN KEY (
      organization_id,
      integration_account_id,
      provider,
      credential_generation,
      external_product_id,
      observation_set_id
    ) REFERENCES operations_commerce_product_image_observation_sets (
      organization_id,
      integration_account_id,
      provider,
      credential_generation,
      external_product_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_set_member_observation_fkey
    FOREIGN KEY (
      organization_id,
      integration_account_id,
      provider,
      credential_generation,
      observation_id,
      observation_revision,
      external_product_id,
      image_identity_sha256,
      locator_sha256,
      observation_source_hash
    ) REFERENCES operations_commerce_product_image_observations (
      organization_id,
      integration_account_id,
      provider,
      credential_generation,
      id,
      observation_revision,
      external_product_id,
      image_identity_sha256,
      locator_sha256,
      source_hash
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_set_member_hashes_valid CHECK (
    image_identity_sha256 ~ '^[0-9a-f]{64}$'
    AND locator_sha256 ~ '^[0-9a-f]{64}$'
    AND observation_source_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE OR REPLACE FUNCTION
  guard_operations_commerce_product_image_observation_set_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Commerce product image observation-set memberships are immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.operations_commerce_product_image_observations observation
    WHERE observation.organization_id = NEW.organization_id
      AND observation.integration_account_id = NEW.integration_account_id
      AND observation.id = NEW.observation_id
      AND observation.lifecycle_state = 'active'
  ) THEN
    RAISE EXCEPTION
      'Commerce product image observation-set member must reference active image evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_operations_commerce_product_image_set_member_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_commerce_product_image_observation_set_memberships
FOR EACH ROW EXECUTE FUNCTION
  guard_operations_commerce_product_image_observation_set_membership();

CREATE OR REPLACE FUNCTION
  validate_ops_commerce_image_set_evidence(
    requested_organization_id uuid,
    requested_integration_account_id uuid,
    requested_observation_set_id uuid
  )
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_count integer;
  expected_identity_set_sha256 text;
  actual_count integer;
  actual_identity_set_sha256 text;
BEGIN
  SELECT
    observation_set.image_identity_count,
    observation_set.image_identity_set_sha256
  INTO expected_count, expected_identity_set_sha256
  FROM public.operations_commerce_product_image_observation_sets
    observation_set
  WHERE observation_set.organization_id = requested_organization_id
    AND observation_set.integration_account_id =
          requested_integration_account_id
    AND observation_set.id = requested_observation_set_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Commerce product image observation-set membership parent is missing';
  END IF;
  SELECT
    count(*)::integer,
    encode(
      digest(
        convert_to(
          'commerce-product-image-identity-set-v1'
          || CASE WHEN count(*) = 0 THEN '' ELSE chr(31) END
          || COALESCE(
            string_agg(
              membership.image_identity_sha256,
              chr(31) ORDER BY membership.image_identity_sha256
            ),
            ''
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
  INTO actual_count, actual_identity_set_sha256
  FROM public.operations_commerce_product_image_observation_set_memberships
    membership
  WHERE membership.organization_id = requested_organization_id
    AND membership.integration_account_id = requested_integration_account_id
    AND membership.observation_set_id = requested_observation_set_id;
  IF actual_count <> expected_count THEN
    RAISE EXCEPTION
      'Commerce product image observation-set membership count does not match immutable evidence';
  END IF;
  IF actual_identity_set_sha256 <> expected_identity_set_sha256 THEN
    RAISE EXCEPTION
      'Commerce product image observation-set membership hash does not match immutable evidence';
  END IF;
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION
  validate_ops_commerce_image_set_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM
    public.validate_ops_commerce_image_set_evidence(
      NEW.organization_id,
      NEW.integration_account_id,
      NEW.id
    );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION
  validate_ops_commerce_image_member_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM
    public.validate_ops_commerce_image_set_evidence(
      NEW.organization_id,
      NEW.integration_account_id,
      NEW.observation_set_id
    );
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER validate_operations_commerce_image_set_membership
AFTER INSERT ON operations_commerce_product_image_observation_sets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_ops_commerce_image_set_row();

CREATE CONSTRAINT TRIGGER validate_operations_commerce_image_set_member_insert
AFTER INSERT ON operations_commerce_product_image_observation_set_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_ops_commerce_image_member_row();

CREATE OR REPLACE FUNCTION
  operations_commerce_product_image_observation_is_current_active(
    requested_organization_id uuid,
    requested_observation_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.operations_commerce_product_image_observations observation
    WHERE observation.organization_id = requested_organization_id
      AND observation.id = requested_observation_id
      AND observation.lifecycle_state = 'active'
      AND public.operations_commerce_product_image_account_is_current(
        observation.organization_id,
        observation.integration_account_id,
        observation.provider,
        observation.credential_generation
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.operations_commerce_product_image_observations later
        WHERE later.organization_id = observation.organization_id
          AND later.integration_account_id =
                observation.integration_account_id
          AND later.credential_generation = observation.credential_generation
          AND later.external_product_id = observation.external_product_id
          AND later.image_identity_sha256 =
                observation.image_identity_sha256
          AND later.observation_revision > observation.observation_revision
      )
  )
$$;

CREATE TABLE operations_commerce_product_image_import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcij'),
  job_generation integer NOT NULL DEFAULT 1 CHECK (job_generation >= 1),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  observation_id uuid NOT NULL,
  observation_revision bigint NOT NULL CHECK (observation_revision >= 1),
  external_product_id text NOT NULL,
  image_identity_sha256 text NOT NULL,
  locator_sha256 text NOT NULL,
  observation_source_hash text NOT NULL,
  pipeline_id uuid,
  product_id uuid,
  product_mapping_id uuid,
  mapping_count integer,
  mapping_fingerprint_sha256 text,
  activation_revision integer,
  asset_alt_text text,
  state text NOT NULL CHECK (state IN (
    'waiting_mapping', 'queued', 'claimed', 'retry',
    'succeeded', 'dead', 'cancelled'
  )),
  wait_reason text CHECK (wait_reason IN (
    'unmapped', 'ambiguous_mapping', 'mapping_changed'
  )),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  last_error_code text,
  result_asset_id uuid,
  result_content_sha256 text,
  completed_at timestamptz,
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ops_commerce_image_job_global_valid
    CHECK (global_id ~ '^gcij[0-9a-v]{12}$'),
  CONSTRAINT ops_commerce_image_job_global_unique UNIQUE (global_id),
  CONSTRAINT ops_commerce_image_job_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_job_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_job_observation_fkey
    FOREIGN KEY (
      organization_id,
      integration_account_id,
      provider,
      credential_generation,
      observation_id,
      observation_revision,
      external_product_id,
      image_identity_sha256,
      locator_sha256,
      observation_source_hash
    ) REFERENCES operations_commerce_product_image_observations (
      organization_id,
      integration_account_id,
      provider,
      credential_generation,
      id,
      observation_revision,
      external_product_id,
      image_identity_sha256,
      locator_sha256,
      source_hash
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_job_pipeline_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_job_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_job_mapping_fkey
    FOREIGN KEY (
      organization_id,
      integration_account_id,
      pipeline_id,
      product_mapping_id,
      product_id
    ) REFERENCES operations_product_mappings (
      organization_id,
      integration_account_id,
      pipeline_id,
      id,
      product_id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_job_result_asset_fkey
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
  CONSTRAINT ops_commerce_image_job_hashes_valid CHECK (
    image_identity_sha256 ~ '^[0-9a-f]{64}$'
    AND locator_sha256 ~ '^[0-9a-f]{64}$'
    AND observation_source_hash ~ '^[0-9a-f]{64}$'
    AND (
      mapping_fingerprint_sha256 IS NULL
      OR mapping_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
    )
    AND (
      result_content_sha256 IS NULL
      OR result_content_sha256 ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT ops_commerce_image_job_mapping_fields_valid CHECK (
    (
      pipeline_id IS NULL
      AND product_id IS NULL
      AND product_mapping_id IS NULL
      AND mapping_count IS NULL
      AND mapping_fingerprint_sha256 IS NULL
      AND activation_revision IS NULL
      AND asset_alt_text IS NULL
    )
    OR (
      pipeline_id IS NOT NULL
      AND product_id IS NOT NULL
      AND product_mapping_id IS NOT NULL
      AND mapping_count BETWEEN 1 AND 10000
      AND mapping_fingerprint_sha256 IS NOT NULL
      AND activation_revision >= 1
      AND length(btrim(asset_alt_text)) BETWEEN 1 AND 500
      AND asset_alt_text !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT ops_commerce_image_job_attempts_valid CHECK (
    max_attempts BETWEEN 1 AND 10
    AND attempt_count BETWEEN 0 AND max_attempts
  ),
  CONSTRAINT ops_commerce_image_job_worker_fields_valid CHECK (
    (claimed_by IS NULL OR (
      length(btrim(claimed_by)) BETWEEN 1 AND 100
      AND claimed_by !~ '[[:cntrl:]]'
    ))
    AND (updated_by = btrim(updated_by))
    AND length(updated_by) BETWEEN 1 AND 255
    AND updated_by !~ '[[:cntrl:]]'
    AND (last_error_code IS NULL OR (
      last_error_code ~ '^[A-Z][A-Z0-9_]{2,99}$'
    ))
  ),
  CONSTRAINT ops_commerce_image_job_state_fields_valid CHECK (
    (
      state = 'waiting_mapping'
      AND wait_reason IS NOT NULL
      AND pipeline_id IS NULL
      AND lease_token IS NULL
      AND claimed_by IS NULL
      AND claimed_at IS NULL
      AND lease_expires_at IS NULL
      AND result_asset_id IS NULL
      AND result_content_sha256 IS NULL
      AND completed_at IS NULL
    )
    OR (
      state IN ('queued', 'retry')
      AND wait_reason IS NULL
      AND pipeline_id IS NOT NULL
      AND lease_token IS NULL
      AND claimed_by IS NULL
      AND claimed_at IS NULL
      AND lease_expires_at IS NULL
      AND result_asset_id IS NULL
      AND result_content_sha256 IS NULL
      AND completed_at IS NULL
    )
    OR (
      state = 'claimed'
      AND wait_reason IS NULL
      AND pipeline_id IS NOT NULL
      AND lease_token IS NOT NULL
      AND claimed_by IS NOT NULL
      AND claimed_at IS NOT NULL
      AND lease_expires_at > claimed_at
      AND lease_expires_at <= claimed_at + interval '15 minutes'
      AND attempt_count >= 1
      AND result_asset_id IS NULL
      AND result_content_sha256 IS NULL
      AND completed_at IS NULL
    )
    OR (
      state = 'succeeded'
      AND wait_reason IS NULL
      AND pipeline_id IS NOT NULL
      AND lease_token IS NULL
      AND claimed_by IS NULL
      AND claimed_at IS NULL
      AND lease_expires_at IS NULL
      AND result_asset_id IS NOT NULL
      AND result_content_sha256 IS NOT NULL
      AND last_error_code IS NULL
      AND completed_at IS NOT NULL
    )
    OR (
      state = 'dead'
      AND wait_reason IS NULL
      AND pipeline_id IS NOT NULL
      AND lease_token IS NULL
      AND claimed_by IS NULL
      AND claimed_at IS NULL
      AND lease_expires_at IS NULL
      AND result_asset_id IS NULL
      AND result_content_sha256 IS NULL
      AND last_error_code IS NOT NULL
      AND completed_at IS NOT NULL
    )
    OR (
      state = 'cancelled'
      AND wait_reason IS NULL
      AND lease_token IS NULL
      AND claimed_by IS NULL
      AND claimed_at IS NULL
      AND lease_expires_at IS NULL
      AND result_asset_id IS NULL
      AND result_content_sha256 IS NULL
      AND last_error_code IS NOT NULL
      AND completed_at IS NOT NULL
    )
  ),
  CONSTRAINT ops_commerce_image_job_observation_generation_unique UNIQUE (
    organization_id, observation_id, job_generation
  ),
  CONSTRAINT ops_commerce_image_job_scoped_id_unique UNIQUE (
    organization_id, integration_account_id, id
  )
);

CREATE UNIQUE INDEX ops_commerce_image_job_single_flight_idx
  ON operations_commerce_product_image_import_jobs (
    organization_id,
    integration_account_id,
    credential_generation,
    external_product_id,
    image_identity_sha256
  )
  WHERE state IN ('queued', 'claimed', 'retry');

CREATE INDEX ops_commerce_image_job_claim_idx
  ON operations_commerce_product_image_import_jobs (
    organization_id, state, available_at, created_at, id
  )
  WHERE state IN ('queued', 'retry', 'claimed', 'waiting_mapping');

-- One aggregate-only worker heartbeat supports deployment health without
-- exposing tenant, account, Product, image, locator, or credential identity.
CREATE TABLE operations_commerce_product_image_import_worker_heartbeat (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  phase text NOT NULL CHECK (phase IN (
    'starting', 'completed', 'degraded'
  )),
  checked_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION
  guard_operations_commerce_product_image_import_worker_heartbeat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.checked_at > statement_timestamp() + interval '1 minute' THEN
    RAISE EXCEPTION 'Image import worker heartbeat cannot be future-dated';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.singleton IS DISTINCT FROM OLD.singleton
      OR NEW.checked_at < OLD.checked_at
    THEN
      RAISE EXCEPTION 'Image import worker heartbeat must advance monotonically';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_commerce_product_image_import_worker_heartbeat_write
BEFORE INSERT OR UPDATE
ON operations_commerce_product_image_import_worker_heartbeat
FOR EACH ROW EXECUTE FUNCTION
  guard_operations_commerce_product_image_import_worker_heartbeat();

CREATE TABLE operations_commerce_product_image_asset_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcip'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  observation_id uuid NOT NULL,
  import_job_id uuid NOT NULL,
  import_job_generation integer NOT NULL CHECK (import_job_generation >= 1),
  external_product_id text NOT NULL,
  image_identity_sha256 text NOT NULL,
  locator_sha256 text NOT NULL,
  observation_source_hash text NOT NULL,
  pipeline_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_mapping_id uuid NOT NULL,
  mapping_count integer NOT NULL CHECK (mapping_count BETWEEN 1 AND 10000),
  mapping_fingerprint_sha256 text NOT NULL,
  activation_revision integer NOT NULL CHECK (activation_revision >= 1),
  asset_id uuid NOT NULL,
  asset_revision bigint NOT NULL CHECK (asset_revision >= 1),
  asset_content_sha256 text NOT NULL,
  imported_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ops_commerce_image_provenance_global_valid
    CHECK (global_id ~ '^gcip[0-9a-v]{12}$'),
  CONSTRAINT ops_commerce_image_provenance_global_unique UNIQUE (global_id),
  CONSTRAINT ops_commerce_image_provenance_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_provenance_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_provenance_observation_fkey
    FOREIGN KEY (organization_id, integration_account_id, observation_id)
    REFERENCES operations_commerce_product_image_observations (
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_provenance_job_fkey
    FOREIGN KEY (organization_id, integration_account_id, import_job_id)
    REFERENCES operations_commerce_product_image_import_jobs (
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_provenance_mapping_fkey
    FOREIGN KEY (
      organization_id,
      integration_account_id,
      pipeline_id,
      product_mapping_id,
      product_id
    ) REFERENCES operations_product_mappings (
      organization_id,
      integration_account_id,
      pipeline_id,
      id,
      product_id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_provenance_asset_fkey
    FOREIGN KEY (organization_id, pipeline_id, product_id, asset_id)
    REFERENCES crm_product_image_assets (
      organization_id, pipeline_id, product_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_provenance_hashes_valid CHECK (
    image_identity_sha256 ~ '^[0-9a-f]{64}$'
    AND locator_sha256 ~ '^[0-9a-f]{64}$'
    AND observation_source_hash ~ '^[0-9a-f]{64}$'
    AND mapping_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
    AND asset_content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ops_commerce_image_provenance_job_unique UNIQUE (
    organization_id, import_job_id
  )
);

CREATE INDEX ops_commerce_image_provenance_asset_idx
  ON operations_commerce_product_image_asset_provenance (
    organization_id, pipeline_id, product_id, asset_id, imported_at
  );

CREATE OR REPLACE FUNCTION
  operations_commerce_product_image_job_fences_are_current(
    requested_organization_id uuid,
    requested_job_id uuid
  )
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_row public.operations_commerce_product_image_import_jobs%ROWTYPE;
  resolution record;
BEGIN
  SELECT * INTO job_row
  FROM public.operations_commerce_product_image_import_jobs job
  WHERE job.organization_id = requested_organization_id
    AND job.id = requested_job_id;

  IF NOT FOUND
    OR job_row.pipeline_id IS NULL
    OR NOT public.operations_commerce_product_image_observation_is_current_active(
      job_row.organization_id,
      job_row.observation_id
    )
  THEN
    RETURN false;
  END IF;

  SELECT * INTO resolution
  FROM public.operations_commerce_product_image_mapping_resolution(
    job_row.organization_id,
    job_row.integration_account_id,
    job_row.provider,
    job_row.external_product_id
  );

  RETURN resolution.resolution_count = 1
    AND resolution.pipeline_id IS NOT DISTINCT FROM job_row.pipeline_id
    AND resolution.product_id IS NOT DISTINCT FROM job_row.product_id
    AND resolution.canonical_product_mapping_id
          IS NOT DISTINCT FROM job_row.product_mapping_id
    AND resolution.mapping_count IS NOT DISTINCT FROM job_row.mapping_count
    AND resolution.mapping_fingerprint_sha256
          IS NOT DISTINCT FROM job_row.mapping_fingerprint_sha256
    AND resolution.activation_revision
          IS NOT DISTINCT FROM job_row.activation_revision;
END;
$$;

CREATE OR REPLACE FUNCTION
  guard_operations_commerce_product_image_import_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  observation_state text;
  resolution record;
  mapped_fence_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Commerce product image import jobs cannot be deleted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.state IN ('succeeded', 'dead', 'cancelled') THEN
      RAISE EXCEPTION 'Terminal commerce product image import jobs are immutable';
    END IF;
    IF ROW(
      NEW.id,
      NEW.global_id,
      NEW.job_generation,
      NEW.organization_id,
      NEW.integration_account_id,
      NEW.provider,
      NEW.credential_generation,
      NEW.observation_id,
      NEW.observation_revision,
      NEW.external_product_id,
      NEW.image_identity_sha256,
      NEW.locator_sha256,
      NEW.observation_source_hash,
      NEW.max_attempts,
      NEW.created_by,
      NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.id,
      OLD.global_id,
      OLD.job_generation,
      OLD.organization_id,
      OLD.integration_account_id,
      OLD.provider,
      OLD.credential_generation,
      OLD.observation_id,
      OLD.observation_revision,
      OLD.external_product_id,
      OLD.image_identity_sha256,
      OLD.locator_sha256,
      OLD.observation_source_hash,
      OLD.max_attempts,
      OLD.created_by,
      OLD.created_at
    ) THEN
      RAISE EXCEPTION 'Commerce product image import job fences are immutable';
    END IF;

    IF NOT (
      (OLD.state = 'waiting_mapping' AND NEW.state IN ('queued', 'cancelled'))
      OR (OLD.state = 'queued' AND NEW.state IN (
        'claimed', 'waiting_mapping', 'cancelled'
      ))
      OR (OLD.state = 'retry' AND NEW.state IN (
        'claimed', 'waiting_mapping', 'cancelled'
      ))
      OR (OLD.state = 'claimed' AND NEW.state IN (
        'retry', 'waiting_mapping', 'succeeded', 'dead', 'cancelled'
      ))
    ) THEN
      RAISE EXCEPTION 'Invalid commerce product image import job transition';
    END IF;

    IF NEW.state = 'claimed' THEN
      IF NEW.attempt_count <> OLD.attempt_count + 1 THEN
        RAISE EXCEPTION 'Image import claim must advance attempt count once';
      END IF;
    ELSIF NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'Image import attempt count changes only on claim';
    END IF;
  END IF;

  SELECT observation.lifecycle_state INTO observation_state
  FROM public.operations_commerce_product_image_observations observation
  WHERE observation.organization_id = NEW.organization_id
    AND observation.id = NEW.observation_id;

  IF observation_state IS NULL THEN
    RAISE EXCEPTION 'Commerce product image observation fence is missing';
  END IF;

  mapped_fence_changed := TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    mapped_fence_changed := ROW(
      NEW.pipeline_id,
      NEW.product_id,
      NEW.product_mapping_id,
      NEW.mapping_count,
      NEW.mapping_fingerprint_sha256,
      NEW.activation_revision
    ) IS DISTINCT FROM ROW(
      OLD.pipeline_id,
      OLD.product_id,
      OLD.product_mapping_id,
      OLD.mapping_count,
      OLD.mapping_fingerprint_sha256,
      OLD.activation_revision
    );
  END IF;

  IF NEW.state IN ('queued', 'claimed', 'retry', 'succeeded', 'dead') THEN
    IF NOT public.operations_commerce_product_image_observation_is_current_active(
      NEW.organization_id,
      NEW.observation_id
    ) THEN
      RAISE EXCEPTION 'Commerce product image import observation fence is stale';
    END IF;

    IF mapped_fence_changed THEN
      SELECT * INTO resolution
      FROM public.operations_commerce_product_image_mapping_resolution(
        NEW.organization_id,
        NEW.integration_account_id,
        NEW.provider,
        NEW.external_product_id
      );
      IF resolution.resolution_count <> 1
        OR resolution.pipeline_id IS DISTINCT FROM NEW.pipeline_id
        OR resolution.product_id IS DISTINCT FROM NEW.product_id
        OR resolution.canonical_product_mapping_id
             IS DISTINCT FROM NEW.product_mapping_id
        OR resolution.mapping_count IS DISTINCT FROM NEW.mapping_count
        OR resolution.mapping_fingerprint_sha256
             IS DISTINCT FROM NEW.mapping_fingerprint_sha256
        OR resolution.activation_revision
             IS DISTINCT FROM NEW.activation_revision
      THEN
        RAISE EXCEPTION 'Commerce product image import mapping fence is stale';
      END IF;
    ELSIF NOT public.operations_commerce_product_image_job_fences_are_current(
      NEW.organization_id,
      NEW.id
    ) THEN
      RAISE EXCEPTION 'Commerce product image import job fences are stale';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.state = 'waiting_mapping' THEN
    IF observation_state <> 'active'
      OR NOT public.operations_commerce_product_image_observation_is_current_active(
        NEW.organization_id,
        NEW.observation_id
      )
    THEN
      RAISE EXCEPTION 'Waiting image import requires a current active observation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.state = 'cancelled' THEN
    IF observation_state <> 'removed'
      OR NEW.last_error_code <> 'IMAGE_REMOVED'
    THEN
      RAISE EXCEPTION
        'Initial cancelled image import requires a removed observation';
    END IF;
  END IF;

  IF NEW.state = 'succeeded' AND NOT EXISTS (
    SELECT 1
    FROM public.operations_commerce_product_image_asset_provenance provenance
    WHERE provenance.organization_id = NEW.organization_id
      AND provenance.import_job_id = NEW.id
      AND provenance.asset_id = NEW.result_asset_id
      AND provenance.asset_content_sha256 = NEW.result_content_sha256
  ) THEN
    RAISE EXCEPTION 'Succeeded image import requires immutable asset provenance';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_operations_commerce_product_image_import_job_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_commerce_product_image_import_jobs
FOR EACH ROW EXECUTE FUNCTION
  guard_operations_commerce_product_image_import_job();

CREATE OR REPLACE FUNCTION
  guard_operations_commerce_product_image_asset_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  exact_link boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Commerce product image asset provenance is immutable';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.operations_commerce_product_image_import_jobs job
    JOIN public.operations_commerce_product_image_observations observation
      ON observation.organization_id = job.organization_id
     AND observation.integration_account_id = job.integration_account_id
     AND observation.id = job.observation_id
    JOIN public.crm_product_image_assets asset
      ON asset.organization_id = job.organization_id
     AND asset.pipeline_id = job.pipeline_id
     AND asset.product_id = job.product_id
     AND asset.id = NEW.asset_id
    WHERE job.organization_id = NEW.organization_id
      AND job.integration_account_id = NEW.integration_account_id
      AND job.id = NEW.import_job_id
      AND job.state = 'claimed'
      AND job.lease_expires_at > statement_timestamp()
      AND public.operations_commerce_product_image_job_fences_are_current(
        job.organization_id,
        job.id
      )
      AND ROW(
        NEW.provider,
        NEW.credential_generation,
        NEW.observation_id,
        NEW.import_job_generation,
        NEW.external_product_id,
        NEW.image_identity_sha256,
        NEW.locator_sha256,
        NEW.observation_source_hash,
        NEW.pipeline_id,
        NEW.product_id,
        NEW.product_mapping_id,
        NEW.mapping_count,
        NEW.mapping_fingerprint_sha256,
        NEW.activation_revision
      ) IS NOT DISTINCT FROM ROW(
        job.provider,
        job.credential_generation,
        job.observation_id,
        job.job_generation,
        job.external_product_id,
        job.image_identity_sha256,
        job.locator_sha256,
        job.observation_source_hash,
        job.pipeline_id,
        job.product_id,
        job.product_mapping_id,
        job.mapping_count,
        job.mapping_fingerprint_sha256,
        job.activation_revision
      )
      AND NEW.asset_revision = asset.asset_revision
      AND NEW.asset_content_sha256 = asset.content_sha256
      AND NEW.observation_source_hash = observation.source_hash
      AND NEW.imported_by = job.created_by
  ) INTO exact_link;

  IF NOT exact_link THEN
    RAISE EXCEPTION
      'Commerce product image provenance does not match current job, mapping, observation, and asset fences';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_operations_commerce_product_image_provenance_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_commerce_product_image_asset_provenance
FOR EACH ROW EXECUTE FUNCTION
  guard_operations_commerce_product_image_asset_provenance();

-- The immutable asset and provenance rows above preserve what was fetched.
-- This row is the credential-scoped current projection that answers whether
-- that evidence is still associated with an image presently exposed by the
-- provider. Provider removal changes only this projection; it never deletes
-- the retained CRM bytes or immutable import provenance.
CREATE TABLE operations_commerce_product_image_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcib'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  external_product_id text NOT NULL,
  image_identity_sha256 text NOT NULL,
  provider_image_id text,
  locator_sha256 text NOT NULL,
  latest_observation_id uuid NOT NULL,
  latest_observation_revision bigint NOT NULL CHECK (
    latest_observation_revision >= 1
  ),
  latest_observation_set_id uuid NOT NULL,
  latest_import_job_id uuid NOT NULL,
  latest_import_job_generation integer NOT NULL CHECK (
    latest_import_job_generation >= 1
  ),
  provider_sequence integer NOT NULL CHECK (
    provider_sequence BETWEEN 0 AND 10000
  ),
  effective_alt_text text NOT NULL,
  pipeline_id uuid NOT NULL,
  product_id uuid NOT NULL,
  activation_revision integer NOT NULL CHECK (activation_revision >= 1),
  asset_id uuid NOT NULL,
  lifecycle_state text NOT NULL CHECK (
    lifecycle_state IN ('active', 'inactive')
  ),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  inactivated_at timestamptz,
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  updated_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ops_commerce_image_binding_global_valid
    CHECK (global_id ~ '^gcib[0-9a-v]{12}$'),
  CONSTRAINT ops_commerce_image_binding_global_unique UNIQUE (global_id),
  CONSTRAINT ops_commerce_image_binding_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_binding_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_binding_observation_fkey
    FOREIGN KEY (
      organization_id,
      integration_account_id,
      latest_observation_id
    ) REFERENCES operations_commerce_product_image_observations (
      organization_id,
      integration_account_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_binding_observation_set_fkey
    FOREIGN KEY (
      organization_id,
      integration_account_id,
      provider,
      credential_generation,
      external_product_id,
      latest_observation_set_id
    ) REFERENCES operations_commerce_product_image_observation_sets (
      organization_id,
      integration_account_id,
      provider,
      credential_generation,
      external_product_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_binding_import_job_fkey
    FOREIGN KEY (
      organization_id,
      integration_account_id,
      latest_import_job_id
    ) REFERENCES operations_commerce_product_image_import_jobs (
      organization_id,
      integration_account_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_binding_pipeline_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_binding_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_binding_asset_fkey
    FOREIGN KEY (organization_id, pipeline_id, product_id, asset_id)
    REFERENCES crm_product_image_assets (
      organization_id, pipeline_id, product_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_commerce_image_binding_product_id_valid CHECK (
    external_product_id = btrim(external_product_id)
    AND length(external_product_id) BETWEEN 1 AND 512
    AND external_product_id !~ '[[:cntrl:]]'
    AND external_product_id !~* 'https?://'
  ),
  CONSTRAINT ops_commerce_image_binding_provider_image_id_valid CHECK (
    provider_image_id IS NULL
    OR (
      provider_image_id = btrim(provider_image_id)
      AND length(provider_image_id) BETWEEN 1 AND 512
      AND provider_image_id !~ '[[:cntrl:]]'
      AND provider_image_id !~* 'https?://'
    )
  ),
  CONSTRAINT ops_commerce_image_binding_hashes_valid CHECK (
    image_identity_sha256 ~ '^[0-9a-f]{64}$'
    AND locator_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ops_commerce_image_binding_alt_valid CHECK (
    length(btrim(effective_alt_text)) BETWEEN 1 AND 500
    AND effective_alt_text !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ops_commerce_image_binding_lifecycle_fields_valid CHECK (
    (lifecycle_state = 'active' AND inactivated_at IS NULL)
    OR (lifecycle_state = 'inactive' AND inactivated_at IS NOT NULL)
  ),
  CONSTRAINT ops_commerce_image_binding_exact_unique UNIQUE (
    organization_id,
    integration_account_id,
    provider,
    credential_generation,
    external_product_id,
    image_identity_sha256
  )
);

CREATE INDEX ops_commerce_image_binding_current_asset_idx
  ON operations_commerce_product_image_bindings (
    organization_id,
    pipeline_id,
    product_id,
    lifecycle_state,
    provider_sequence,
    provider,
    integration_account_id,
    external_product_id,
    image_identity_sha256,
    asset_id
  );

CREATE OR REPLACE FUNCTION
  guard_operations_commerce_product_image_binding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  exact_projection boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Commerce product image bindings cannot be deleted';
  END IF;

  IF NOT public.operations_commerce_product_image_account_is_current(
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.provider,
    NEW.credential_generation
  ) THEN
    RAISE EXCEPTION
      'Commerce product image binding requires the current verified account credential';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'Commerce product image binding must start at row version one';
    END IF;
  ELSE
    IF ROW(
      NEW.id,
      NEW.global_id,
      NEW.organization_id,
      NEW.integration_account_id,
      NEW.provider,
      NEW.credential_generation,
      NEW.external_product_id,
      NEW.image_identity_sha256,
      NEW.created_by,
      NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.id,
      OLD.global_id,
      OLD.organization_id,
      OLD.integration_account_id,
      OLD.provider,
      OLD.credential_generation,
      OLD.external_product_id,
      OLD.image_identity_sha256,
      OLD.created_by,
      OLD.created_at
    ) THEN
      RAISE EXCEPTION 'Commerce product image binding scope is immutable';
    END IF;
    IF NEW.row_version <> OLD.row_version + 1 THEN
      RAISE EXCEPTION
        'Commerce product image binding row version must advance by one';
    END IF;
    IF NEW.latest_observation_revision < OLD.latest_observation_revision
      OR (
        NEW.latest_observation_revision = OLD.latest_observation_revision
        AND NEW.latest_import_job_generation <=
              OLD.latest_import_job_generation
      )
    THEN
      RAISE EXCEPTION
        'Commerce product image binding observation/job generation cannot regress or replay';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION
        'Commerce product image binding update timestamp cannot regress';
    END IF;
    IF NEW.lifecycle_state = 'inactive'
      AND ROW(
        NEW.pipeline_id,
        NEW.product_id,
        NEW.activation_revision,
        NEW.asset_id,
        NEW.latest_import_job_id,
        NEW.latest_import_job_generation
      )
            IS DISTINCT FROM
          ROW(
            OLD.pipeline_id,
            OLD.product_id,
            OLD.activation_revision,
            OLD.asset_id,
            OLD.latest_import_job_id,
            OLD.latest_import_job_generation
          )
    THEN
      RAISE EXCEPTION
        'Inactive commerce product image binding asset lineage is immutable';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.operations_commerce_product_image_observations observation
    JOIN public.operations_commerce_product_image_observation_sets
      observation_set
      ON observation_set.organization_id = observation.organization_id
     AND observation_set.integration_account_id =
           observation.integration_account_id
     AND observation_set.id = observation.observation_set_id
    JOIN public.crm_product_image_assets asset
      ON asset.organization_id = NEW.organization_id
     AND asset.pipeline_id = NEW.pipeline_id
     AND asset.product_id = NEW.product_id
     AND asset.id = NEW.asset_id
    WHERE observation.organization_id = NEW.organization_id
      AND observation.integration_account_id = NEW.integration_account_id
      AND observation.provider = NEW.provider
      AND observation.credential_generation = NEW.credential_generation
      AND observation.external_product_id = NEW.external_product_id
      AND observation.image_identity_sha256 = NEW.image_identity_sha256
      AND observation.id = NEW.latest_observation_id
      AND observation.observation_revision =
            NEW.latest_observation_revision
      AND observation.observation_set_id = NEW.latest_observation_set_id
      AND observation.provider_image_id IS NOT DISTINCT FROM
            NEW.provider_image_id
      AND observation.locator_sha256 = NEW.locator_sha256
      AND observation.image_sequence = NEW.provider_sequence
      AND (
        observation.alt_text IS NULL
        OR observation.alt_text = NEW.effective_alt_text
      )
      AND (
        (
          NEW.lifecycle_state = 'active'
          AND observation.lifecycle_state = 'active'
          AND EXISTS (
            SELECT 1
            FROM public.operations_activation_scopes activation
            WHERE activation.organization_id = NEW.organization_id
              AND activation.data_pipeline_id = NEW.pipeline_id
              AND activation.state IN ('shadow', 'active')
              AND activation.revision = NEW.activation_revision
          )
          AND public.operations_commerce_product_image_observation_is_current_active(
            NEW.organization_id,
            NEW.latest_observation_id
          )
          AND public.operations_commerce_product_image_job_fences_are_current(
            NEW.organization_id,
            NEW.latest_import_job_id
          )
          AND EXISTS (
            SELECT 1
            FROM public.operations_commerce_product_image_asset_provenance
              provenance
            JOIN public.operations_commerce_product_image_import_jobs
              import_job
              ON import_job.organization_id = provenance.organization_id
             AND import_job.id = provenance.import_job_id
             AND import_job.job_generation =
                   provenance.import_job_generation
            WHERE provenance.organization_id = NEW.organization_id
              AND provenance.integration_account_id =
                    NEW.integration_account_id
              AND provenance.provider = NEW.provider
              AND provenance.credential_generation =
                    NEW.credential_generation
              AND provenance.observation_id = NEW.latest_observation_id
              AND provenance.import_job_id = NEW.latest_import_job_id
              AND provenance.import_job_generation =
                    NEW.latest_import_job_generation
              AND provenance.external_product_id = NEW.external_product_id
              AND provenance.image_identity_sha256 =
                    NEW.image_identity_sha256
              AND provenance.pipeline_id = NEW.pipeline_id
              AND provenance.product_id = NEW.product_id
              AND provenance.activation_revision = NEW.activation_revision
              AND provenance.asset_id = NEW.asset_id
              AND import_job.state = 'succeeded'
              AND import_job.result_asset_id = NEW.asset_id
              AND import_job.activation_revision = NEW.activation_revision
          )
        )
        OR (
          NEW.lifecycle_state = 'inactive'
          AND observation.lifecycle_state = 'removed'
          AND observation_set.image_set_complete = true
          AND NOT EXISTS (
            SELECT 1
            FROM public.operations_commerce_product_image_observations later
            WHERE later.organization_id = observation.organization_id
              AND later.integration_account_id =
                    observation.integration_account_id
              AND later.credential_generation =
                    observation.credential_generation
              AND later.external_product_id = observation.external_product_id
              AND later.image_identity_sha256 =
                    observation.image_identity_sha256
              AND later.observation_revision >
                    observation.observation_revision
          )
        )
      )
  ) INTO exact_projection;

  IF NOT exact_projection THEN
    RAISE EXCEPTION
      'Commerce product image binding does not match current observation, asset, and lifecycle evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_operations_commerce_product_image_binding_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_commerce_product_image_bindings
FOR EACH ROW EXECUTE FUNCTION
  guard_operations_commerce_product_image_binding();

COMMENT ON TABLE operations_commerce_product_image_observations IS
  'Immutable Shopify/Faire image observations. Stores identifiers, bounded metadata, and SHA-256 fingerprints only; never raw locators, payloads, bytes, credentials, or provider-write evidence.';

COMMENT ON TABLE operations_commerce_product_image_snapshot_fences IS
  'Credential-scoped monotonic product-image snapshot heads. Older observed-at snapshots are ignored and equal timestamps must identify identical fingerprint-only evidence.';

COMMENT ON TABLE operations_commerce_product_image_observation_sets IS
  'Immutable product-level source and completeness evidence for one normalized provider image set, including complete empty sets. Stores counts and SHA-256 fingerprints only.';

COMMENT ON TABLE operations_commerce_product_image_import_jobs IS
  'Bounded single-flight image import state with exact credential, observation, mapping-set, Product, lease, retry, and terminal fences. This queue grants no provider-write authority.';

COMMENT ON TABLE operations_commerce_product_image_import_worker_heartbeat IS
  'Aggregate-only latest image-import worker heartbeat. Contains no tenant, account, Product, image, locator, or credential identity.';

COMMENT ON TABLE operations_commerce_product_image_asset_provenance IS
  'Immutable link from one exact provider image observation and import job to the reused or newly-created CRM image asset content hash. Provider removal never deletes this evidence or its asset.';

COMMENT ON TABLE operations_commerce_product_image_bindings IS
  'Credential-scoped current provider-image projection onto immutable CRM asset evidence. Complete removals inactivate the binding without deleting bytes; current active bindings drive CRM visibility and deterministic provider-primary selection.';
