-- A short integration-credential proof outage or a committed Store sync pause
-- is maintenance, not an image import attempt. Permit only the exact
-- claimed-to-queued parking transition used to release that lease and restore
-- the consumed attempt.

SET LOCAL search_path = public, pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

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
  maintenance_parking boolean := false;
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

    maintenance_parking :=
      OLD.state = 'claimed'
      AND NEW.state = 'queued'
      AND NEW.attempt_count = OLD.attempt_count - 1
      AND (
        NEW.last_error_code
          ~ '^INTEGRATION_CREDENTIAL_RUNTIME_[A-Z0-9_]{1,96}$'
        OR NEW.last_error_code = 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED'
      )
      AND NEW.lease_token IS NULL
      AND NEW.claimed_by IS NULL
      AND NEW.claimed_at IS NULL
      AND NEW.lease_expires_at IS NULL
      AND NEW.completed_at IS NULL
      AND ROW(
        NEW.pipeline_id,
        NEW.product_id,
        NEW.product_mapping_id,
        NEW.mapping_count,
        NEW.mapping_fingerprint_sha256,
        NEW.activation_revision,
        NEW.asset_alt_text
      ) IS NOT DISTINCT FROM ROW(
        OLD.pipeline_id,
        OLD.product_id,
        OLD.product_mapping_id,
        OLD.mapping_count,
        OLD.mapping_fingerprint_sha256,
        OLD.activation_revision,
        OLD.asset_alt_text
      );

    IF NOT (
      maintenance_parking
      OR (
        OLD.state = 'waiting_mapping'
        AND NEW.state IN ('queued', 'cancelled')
      )
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

    IF maintenance_parking THEN
      NULL;
    ELSIF NEW.state = 'claimed' THEN
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

COMMENT ON FUNCTION guard_operations_commerce_product_image_import_job() IS
  'Protects immutable image-import fences and allows a claimed job to restore exactly one attempt only when a typed integration-credential runtime outage or committed Store sync pause parks it.';
