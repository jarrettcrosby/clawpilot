-- Exact product-image fan-out for provider product images.
--
-- Shopify and Faire expose images at product scope while ClawPilot may model
-- each exact provider variant as a separate CRM Product. A product image is
-- therefore unambiguous when all current mappings are exact and belong to one
-- active pipeline/revision, even when those mappings resolve to several CRM
-- Products. The import job continues to fetch and validate the provider bytes
-- once; immutable provenance and current bindings are recorded once per exact
-- CRM Product target.

CREATE OR REPLACE FUNCTION
  operations_commerce_product_image_mapping_targets(
    requested_organization_id uuid,
    requested_integration_account_id uuid,
    requested_provider text,
    requested_external_product_id text
  )
RETURNS TABLE (
  pipeline_id uuid,
  product_id uuid,
  canonical_product_mapping_id uuid,
  target_mapping_count integer,
  target_mapping_fingerprint_sha256 text,
  activation_revision integer,
  product_name text,
  mapping_count integer,
  mapping_fingerprint_sha256 text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH channel_scope AS (
    SELECT DISTINCT
      channel_state.id AS channel_state_id,
      channel_state.product_id AS channel_product_id,
      channel_state.product_mapping_id AS channel_product_mapping_id,
      channel_state.external_product_id AS channel_external_product_id,
      channel_state.external_variant_id AS channel_external_variant_id,
      mapping.id AS mapping_id,
      mapping.pipeline_id AS mapping_pipeline_id,
      mapping.product_id AS mapping_product_id,
      mapping.external_product_id AS mapping_external_product_id,
      mapping.external_variant_id AS mapping_external_variant_id,
      mapping.mapping_method,
      mapping.active AS mapping_active,
      activation.revision AS activation_revision,
      product.id AS resolved_product_id,
      product.name AS product_name
    FROM public.operations_product_channel_states channel_state
    LEFT JOIN public.operations_product_mappings mapping
      ON mapping.organization_id = channel_state.organization_id
     AND mapping.integration_account_id =
           channel_state.integration_account_id
     AND mapping.pipeline_id = channel_state.pipeline_id
     AND mapping.id = channel_state.product_mapping_id
     AND mapping.product_id = channel_state.product_id
    LEFT JOIN public.crm_products product
      ON product.pipeline_id = mapping.pipeline_id
     AND product.id = mapping.product_id
    LEFT JOIN public.operations_activation_scopes activation
      ON activation.organization_id = mapping.organization_id
     AND activation.data_pipeline_id = mapping.pipeline_id
     AND activation.state IN ('shadow', 'active')
    WHERE channel_state.organization_id = requested_organization_id
      AND channel_state.integration_account_id =
            requested_integration_account_id
      AND channel_state.provider = requested_provider
      AND channel_state.external_product_id =
            requested_external_product_id
  ),
  scope_validity AS (
    SELECT
      count(*) FILTER (
        WHERE channel_scope.mapping_active = true
          AND channel_scope.activation_revision IS NOT NULL
      ) > 0
      AND bool_and(COALESCE(
        channel_scope.channel_product_id IS NOT NULL
        AND channel_scope.channel_product_mapping_id IS NOT NULL
        AND channel_scope.mapping_id IS NOT NULL
        AND channel_scope.mapping_active = true
        AND channel_scope.mapping_external_product_id =
              channel_scope.channel_external_product_id
        AND channel_scope.mapping_external_variant_id =
              channel_scope.channel_external_variant_id
        AND channel_scope.resolved_product_id IS NOT NULL
        AND channel_scope.activation_revision IS NOT NULL,
        false
      )) FILTER (
        WHERE channel_scope.mapping_active = true
          AND channel_scope.activation_revision IS NOT NULL
      ) AS complete_exact_scope
    FROM channel_scope
  ),
  exact_mapping AS (
    SELECT DISTINCT
      channel_scope.mapping_id AS id,
      channel_scope.mapping_pipeline_id AS pipeline_id,
      channel_scope.mapping_product_id AS product_id,
      channel_scope.mapping_external_product_id AS external_product_id,
      channel_scope.mapping_external_variant_id AS external_variant_id,
      channel_scope.mapping_method,
      channel_scope.activation_revision,
      channel_scope.product_name
    FROM channel_scope
    WHERE channel_scope.mapping_active = true
      AND channel_scope.activation_revision IS NOT NULL
      AND (SELECT complete_exact_scope FROM scope_validity)
  ),
  mapping_scope AS (
    SELECT
      exact_mapping.pipeline_id,
      exact_mapping.activation_revision,
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
      ) AS mapping_hash
    FROM exact_mapping
    GROUP BY
      exact_mapping.pipeline_id,
      exact_mapping.activation_revision
  ),
  target AS (
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
  )
  SELECT
    target.pipeline_id,
    target.product_id,
    target.canonical_mapping_id,
    target.exact_mapping_count,
    target.mapping_hash,
    target.activation_revision,
    target.resolved_product_name,
    mapping_scope.exact_mapping_count,
    mapping_scope.mapping_hash
  FROM target
  JOIN mapping_scope
    ON mapping_scope.pipeline_id = target.pipeline_id
   AND mapping_scope.activation_revision = target.activation_revision
  ORDER BY
    target.pipeline_id::text,
    target.activation_revision,
    target.product_id::text,
    target.canonical_mapping_id::text
$$;

-- Preserve the existing scalar contract for jobs. resolution_count now means
-- the number of active pipeline/revision scopes. Multiple exact CRM Products
-- inside one scope resolve to one fenced fan-out, while multiple scopes remain
-- ambiguous and fail closed.
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
  WITH target AS (
    SELECT *
    FROM public.operations_commerce_product_image_mapping_targets(
      requested_organization_id,
      requested_integration_account_id,
      requested_provider,
      requested_external_product_id
    )
  ),
  scope AS (
    SELECT DISTINCT
      target.pipeline_id,
      target.activation_revision,
      target.mapping_count,
      target.mapping_fingerprint_sha256
    FROM target
  ),
  resolution AS (
    SELECT count(*)::integer AS candidate_count
    FROM scope
  ),
  canonical AS (
    SELECT target.*
    FROM target
    JOIN scope
      ON scope.pipeline_id = target.pipeline_id
     AND scope.activation_revision = target.activation_revision
     AND scope.mapping_count = target.mapping_count
     AND scope.mapping_fingerprint_sha256 =
           target.mapping_fingerprint_sha256
    WHERE (SELECT candidate_count FROM resolution) = 1
    ORDER BY
      target.product_id::text,
      target.canonical_product_mapping_id::text
    LIMIT 1
  )
  SELECT
    resolution.candidate_count,
    CASE WHEN resolution.candidate_count = 1
      THEN canonical.pipeline_id ELSE NULL END,
    CASE WHEN resolution.candidate_count = 1
      THEN canonical.product_id ELSE NULL END,
    CASE WHEN resolution.candidate_count = 1
      THEN canonical.canonical_product_mapping_id ELSE NULL END,
    CASE WHEN resolution.candidate_count = 1
      THEN canonical.mapping_count ELSE NULL END,
    CASE WHEN resolution.candidate_count = 1
      THEN canonical.mapping_fingerprint_sha256 ELSE NULL END,
    CASE WHEN resolution.candidate_count = 1
      THEN canonical.activation_revision ELSE NULL END,
    CASE WHEN resolution.candidate_count = 1
      THEN canonical.product_name ELSE NULL END
  FROM resolution
  LEFT JOIN canonical ON resolution.candidate_count = 1
$$;

-- One provider read may now create one immutable provenance row per exact CRM
-- Product. A job/product pair remains unique and replay safe.
ALTER TABLE operations_commerce_product_image_asset_provenance
  DROP CONSTRAINT ops_commerce_image_provenance_job_unique;

ALTER TABLE operations_commerce_product_image_asset_provenance
  ADD CONSTRAINT ops_commerce_image_provenance_job_product_unique UNIQUE (
    organization_id,
    import_job_id,
    product_id
  );

-- Current provider-image bindings are product projections. Include the exact
-- CRM Product in their identity so sibling variants do not overwrite one
-- another.
ALTER TABLE operations_commerce_product_image_bindings
  DROP CONSTRAINT ops_commerce_image_binding_exact_unique;

ALTER TABLE operations_commerce_product_image_bindings
  ADD CONSTRAINT ops_commerce_image_binding_exact_product_unique UNIQUE (
    organization_id,
    integration_account_id,
    provider,
    credential_generation,
    external_product_id,
    image_identity_sha256,
    product_id
  );

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
      ON asset.organization_id = NEW.organization_id
     AND asset.pipeline_id = NEW.pipeline_id
     AND asset.product_id = NEW.product_id
     AND asset.id = NEW.asset_id
    JOIN LATERAL
      public.operations_commerce_product_image_mapping_targets(
        job.organization_id,
        job.integration_account_id,
        job.provider,
        job.external_product_id
      ) target
      ON target.pipeline_id = NEW.pipeline_id
     AND target.product_id = NEW.product_id
     AND target.canonical_product_mapping_id = NEW.product_mapping_id
     AND target.activation_revision = NEW.activation_revision
     AND target.mapping_count = NEW.mapping_count
     AND target.mapping_fingerprint_sha256 =
           NEW.mapping_fingerprint_sha256
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
      'Commerce product image provenance does not match current job, exact fan-out target, observation, and asset fences';
  END IF;
  RETURN NEW;
END;
$$;

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
      NEW.pipeline_id,
      NEW.product_id,
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
      OLD.pipeline_id,
      OLD.product_id,
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
      'Commerce product image binding does not match current observation, exact fan-out target, asset, and lifecycle evidence';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION operations_commerce_product_image_mapping_targets(
  uuid, uuid, text, text
) IS
  'Returns every exact current CRM Product target for one provider product, with per-target and complete-set SHA-256 mapping fences.';

COMMENT ON CONSTRAINT ops_commerce_image_provenance_job_product_unique
  ON operations_commerce_product_image_asset_provenance IS
  'One immutable asset-provenance result per import job and exact CRM Product fan-out target.';

COMMENT ON CONSTRAINT ops_commerce_image_binding_exact_product_unique
  ON operations_commerce_product_image_bindings IS
  'One current provider-image binding per exact CRM Product fan-out target.';
