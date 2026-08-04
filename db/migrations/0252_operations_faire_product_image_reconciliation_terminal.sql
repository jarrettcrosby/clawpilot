-- An uncertain Faire Product-image attachment is never replayed. A later
-- authoritative Product read may, however, prove that the one uploaded
-- locator tied to the immutable asset content is attached exactly once. Keep
-- the original provider-attempt evidence unknown and append the readback step,
-- while allowing only that exact proof to resolve the external effect.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

CREATE OR REPLACE FUNCTION
  operations_faire_product_image_exact_reconciliation_transition_is_valid(
    scoped_organization_id uuid,
    scoped_external_effect_id uuid,
    candidate_result jsonb,
    candidate_terminal_evidence_hash text,
    candidate_provider_reference text,
    candidate_provider_write_count integer,
    candidate_completed_at timestamptz
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((
    SELECT bool_or(
      effect.provider = 'faire'
      AND effect.action = 'faire.product.image.publish'
      AND effect.desired_mode = 'active'
      AND effect.state = 'unknown'
      AND effect.provider_write_count = 1
      AND effect.terminal_evidence_hash ~ '^[a-f0-9]{64}$'
      AND effect.error_code IS NOT NULL
      AND effect.completed_at IS NOT NULL
      AND attempt.state = 'unknown'
      AND attempt.redacted_response = effect.redacted_result
      AND attempt.provider_reference IS NOT DISTINCT FROM
            effect.provider_reference
      AND attempt.error_code IS NOT DISTINCT FROM effect.error_code
      AND effect.redacted_result->>'provider' = 'faire'
      AND effect.redacted_result->>'operation' = 'productImagePublish'
      AND effect.redacted_result->>'outcome' = 'unknown'
      AND effect.redacted_result->>'deliveryGrantId' = image_grant.id::text
      AND effect.redacted_result->>'assetContentSha256' =
            image_grant.asset_content_sha256
      AND effect.redacted_result->>'uploadedLocatorSha256' =
            upload.uploaded_locator_sha256
      AND effect.redacted_result->>'existingImagesPreserved' = 'true'
      AND effect.redacted_result->>'providerWrites' = '1'
      AND jsonb_typeof(
            effect.redacted_result->'priorImageCount'
          ) = 'number'
      AND jsonb_typeof(
            effect.redacted_result->'projectedImageCount'
          ) = 'number'
      AND (effect.redacted_result->>'priorImageCount')::numeric
            BETWEEN 0 AND 19
      AND (effect.redacted_result->>'projectedImageCount')::numeric
            BETWEEN 1 AND 20
      AND (effect.redacted_result->>'projectedImageCount')::numeric =
            (effect.redacted_result->>'priorImageCount')::numeric + 1
      AND resolution.stage = 'reconcile'
      AND resolution.outcome = 'observed_applied'
      AND resolution.provider_attempt_id IS NULL
      AND resolution.provider_write_count = 2
      AND resolution.uploaded_locator_sha256 =
            upload.uploaded_locator_sha256
      AND resolution.observed_at >= effect.completed_at
      AND resolution.redacted_evidence->>'provider' = 'faire'
      AND resolution.redacted_evidence->>'operation' =
            'productImagePublishReconciliation'
      AND resolution.redacted_evidence->>'outcome' = 'observed_applied'
      AND resolution.redacted_evidence->>'externalProductId' =
            image_grant.external_product_id
      AND resolution.redacted_evidence->>'assetContentSha256' =
            image_grant.asset_content_sha256
      AND resolution.redacted_evidence->>'uploadedLocatorSha256' =
            upload.uploaded_locator_sha256
      AND resolution.redacted_evidence->>'providerImageCount' =
            effect.redacted_result->>'projectedImageCount'
      AND resolution.redacted_evidence->>'exactLocatorMatchCount' = '1'
      AND resolution.redacted_evidence->>'providerImageSetSha256' ~
            '^[a-f0-9]{64}$'
      AND resolution.redacted_evidence->>'providerWrites' = '2'
      AND resolution.redacted_evidence->>'reconciledBy' =
            resolution.recorded_by
      AND membership.role IN ('owner', 'admin')
      AND membership.status = 'active'
      AND upload.stage = 'upload'
      AND upload.outcome = 'succeeded'
      AND upload.provider_attempt_id = effect.provider_attempt_id
      AND upload.provider_write_count = 1
      AND upload.redacted_evidence->>'provider' = 'faire'
      AND upload.redacted_evidence->>'operation' = 'productImageUpload'
      AND upload.redacted_evidence->>'outcome' = 'succeeded'
      AND upload.redacted_evidence->>'assetContentSha256' =
            image_grant.asset_content_sha256
      AND upload.redacted_evidence->>'uploadedLocatorSha256' =
            upload.uploaded_locator_sha256
      AND upload.redacted_evidence->>'providerWrites' = '1'
      AND candidate_result->>'provider' = 'faire'
      AND candidate_result->>'action' = 'faire.product.image.publish'
      AND candidate_result->>'operation' = 'productImagePublish'
      AND candidate_result->>'outcome' = 'succeeded'
      AND candidate_result->>'stage' =
            'exact_product_readback_reconciliation'
      AND candidate_result ? 'errorCode'
      AND candidate_result->'errorCode' = 'null'::jsonb
      AND candidate_result->>'deliveryGrantId' = image_grant.id::text
      AND candidate_result->>'externalProductId' =
            image_grant.external_product_id
      AND candidate_result->>'assetContentSha256' =
            image_grant.asset_content_sha256
      AND candidate_result->>'uploadedLocatorSha256' =
            upload.uploaded_locator_sha256
      AND candidate_result->>'existingImagesPreserved' = 'true'
      AND candidate_result->>'priorImageCount' =
            effect.redacted_result->>'priorImageCount'
      AND candidate_result->>'projectedImageCount' =
            resolution.redacted_evidence->>'providerImageCount'
      AND candidate_result->>'providerWritesKnown' = 'true'
      AND candidate_result->>'providerWriteCountLowerBound' = '2'
      AND candidate_result->>'providerWrites' = '2'
      AND candidate_result->>'reconciliationStepId' = resolution.id::text
      AND candidate_result->>'reconciledFromState' = 'unknown'
      AND candidate_result->>'reconciledFromTerminalEvidenceHash' =
            effect.terminal_evidence_hash
      AND candidate_result->>'providerImageSetSha256' =
            resolution.redacted_evidence->>'providerImageSetSha256'
      AND candidate_result->>'providerImageCount' =
            resolution.redacted_evidence->>'providerImageCount'
      AND candidate_result->>'exactLocatorMatchCount' = '1'
      AND candidate_result->>'reconciledBy' = resolution.recorded_by
      AND candidate_terminal_evidence_hash =
            operations_faire_provider_write_request_hash(candidate_result)
      AND candidate_provider_reference = image_grant.external_product_id
      AND candidate_provider_write_count = 2
      AND candidate_completed_at = resolution.observed_at
    )
    FROM operations_commerce_external_effect_intents effect
    JOIN operations_faire_product_image_delivery_grants image_grant
      ON image_grant.organization_id = effect.organization_id
     AND image_grant.integration_account_id = effect.integration_account_id
     AND image_grant.idempotency_key = effect.idempotency_key
    JOIN operations_commerce_provider_attempts attempt
      ON attempt.organization_id = effect.organization_id
     AND attempt.integration_account_id = effect.integration_account_id
     AND attempt.id = effect.provider_attempt_id
    JOIN operations_faire_product_image_provider_steps resolution
      ON resolution.organization_id = effect.organization_id
     AND resolution.integration_account_id = effect.integration_account_id
     AND resolution.external_effect_id = effect.id
     AND resolution.delivery_grant_id = image_grant.id
     AND resolution.id = CASE
       WHEN candidate_result->>'reconciliationStepId' ~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       THEN (candidate_result->>'reconciliationStepId')::uuid
       ELSE NULL
     END
    JOIN operations_faire_product_image_provider_steps upload
      ON upload.organization_id = effect.organization_id
     AND upload.integration_account_id = effect.integration_account_id
     AND upload.external_effect_id = effect.id
     AND upload.delivery_grant_id = image_grant.id
     AND upload.uploaded_locator_sha256 =
           resolution.uploaded_locator_sha256
    JOIN app_user_organization_memberships membership
      ON membership.organization_id = effect.organization_id
     AND membership.user_email = resolution.recorded_by
    WHERE effect.organization_id = scoped_organization_id
      AND effect.id = scoped_external_effect_id
  ), false)
$$;

DO $migration$
DECLARE
  function_definition text;
  original_definition text;
  declaration_anchor text :=
    '  exact_faire_write_authority boolean := false;';
  provider_count_guard text :=
    '  IF TG_OP = ''UPDATE''
     AND NEW.provider_write_count IS DISTINCT FROM OLD.provider_write_count
     AND NOT (
       OLD.state = ''claimed''
       AND NEW.state IN (''succeeded'', ''failed'', ''unknown'')
     ) THEN';
  terminal_guard text :=
    '  IF OLD.state IN (''simulated'', ''succeeded'', ''failed'', ''unknown'') THEN';
BEGIN
  SELECT pg_get_functiondef(
    'protect_operations_commerce_external_effect_intent()'::regprocedure
  ) INTO function_definition;

  IF strpos(
    function_definition,
    'exact_faire_product_image_reconciliation'
  ) > 0 THEN
    RETURN;
  END IF;
  original_definition := function_definition;

  function_definition := replace(
    function_definition,
    declaration_anchor,
    declaration_anchor || E'\n  exact_faire_product_image_reconciliation boolean := false;'
  );
  IF function_definition = original_definition THEN
    RAISE EXCEPTION
      'Commerce external-effect trigger declaration anchor was not found';
  END IF;

  original_definition := function_definition;
  function_definition := replace(
    function_definition,
    provider_count_guard,
    '  IF TG_OP = ''UPDATE'' THEN
    exact_faire_product_image_reconciliation := (
      OLD.state = ''unknown''
      AND NEW.state = ''succeeded''
      AND NEW.provider_attempt_id IS NOT DISTINCT FROM OLD.provider_attempt_id
      AND NEW.claimed_by IS NOT DISTINCT FROM OLD.claimed_by
      AND NEW.claimed_at IS NOT DISTINCT FROM OLD.claimed_at
      AND NEW.lease_token IS NULL
      AND OLD.lease_token IS NULL
      AND NEW.lease_expires_at IS NULL
      AND OLD.lease_expires_at IS NULL
      AND NEW.error_code IS NULL
      AND NEW.updated_at = NEW.completed_at
      AND operations_faire_product_image_exact_reconciliation_transition_is_valid(
        OLD.organization_id,
        OLD.id,
        NEW.redacted_result,
        NEW.terminal_evidence_hash,
        NEW.provider_reference,
        NEW.provider_write_count,
        NEW.completed_at
      )
    );
  END IF;

' || replace(
      provider_count_guard,
      ') THEN',
      E')\n     AND NOT exact_faire_product_image_reconciliation THEN'
    )
  );
  IF function_definition = original_definition THEN
    RAISE EXCEPTION
      'Commerce external-effect provider-count guard was not found';
  END IF;

  original_definition := function_definition;
  function_definition := replace(
    function_definition,
    terminal_guard,
    '  IF exact_faire_product_image_reconciliation THEN
    RETURN NEW;
  END IF;

' || terminal_guard
  );
  IF function_definition = original_definition THEN
    RAISE EXCEPTION
      'Commerce external-effect terminal guard was not found';
  END IF;

  EXECUTE function_definition;
END;
$migration$;

COMMENT ON FUNCTION
  operations_faire_product_image_exact_reconciliation_transition_is_valid(
    uuid, uuid, jsonb, text, text, integer, timestamptz
  ) IS
  'Validates the sole unknown-to-succeeded external-effect transition: one append-only exact Faire Product readback tied to the immutable successful upload locator and asset content.';
