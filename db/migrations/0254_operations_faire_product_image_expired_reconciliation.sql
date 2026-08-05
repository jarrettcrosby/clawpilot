-- Extend the exact Faire Product-image reconciliation exception without
-- weakening the generic immutable terminal-effect guard. One-write unknown
-- outcomes may be proved by their exact terminal evidence or by an exact
-- attach/unknown step. Two-write expired outcomes require an exact durable
-- attach/succeeded step. Both paths also require the attempt-fenced upload,
-- the active owner/admin readback step, and a hash-exact source result.

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
  SELECT EXISTS (
    SELECT 1
    FROM operations_commerce_external_effect_intents effect
    JOIN operations_faire_product_image_delivery_grants image_grant
      ON image_grant.organization_id = effect.organization_id
     AND image_grant.integration_account_id = effect.integration_account_id
     AND image_grant.idempotency_key = effect.idempotency_key
    JOIN operations_commerce_provider_attempts attempt
      ON attempt.organization_id = effect.organization_id
     AND attempt.integration_account_id = effect.integration_account_id
     AND attempt.id = effect.provider_attempt_id
     AND attempt.action = 'external_effect:' || effect.action
     AND attempt.idempotency_key = effect.idempotency_key
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
     AND upload.provider_attempt_id = effect.provider_attempt_id
     AND upload.uploaded_locator_sha256 =
           resolution.uploaded_locator_sha256
    LEFT JOIN operations_faire_product_image_provider_steps attach
      ON attach.organization_id = effect.organization_id
     AND attach.integration_account_id = effect.integration_account_id
     AND attach.external_effect_id = effect.id
     AND attach.delivery_grant_id = image_grant.id
     AND attach.provider_attempt_id = effect.provider_attempt_id
     AND attach.id = CASE
       WHEN candidate_result->>'durableAttachStepId' ~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       THEN (candidate_result->>'durableAttachStepId')::uuid
       ELSE NULL
     END
    JOIN app_user_organization_memberships resolution_membership
      ON resolution_membership.organization_id = effect.organization_id
     AND resolution_membership.user_email = resolution.recorded_by
     AND resolution_membership.role IN ('owner', 'admin')
     AND resolution_membership.status = 'active'
    CROSS JOIN LATERAL generate_series(0, 19)
      AS expected(prior_image_count)
    WHERE effect.organization_id = scoped_organization_id
      AND effect.id = scoped_external_effect_id
      AND effect.provider = 'faire'
      AND effect.action = 'faire.product.image.publish'
      AND effect.desired_mode = 'active'
      AND effect.state = 'unknown'
      AND effect.provider_write_count IN (1, 2)
      AND effect.terminal_evidence_hash ~ '^[a-f0-9]{64}$'
      AND effect.terminal_evidence_hash =
            operations_faire_provider_write_request_hash(
              effect.redacted_result
            )
      AND effect.provider_reference = image_grant.external_product_id
      AND effect.error_code IS NOT NULL
      AND effect.completed_at IS NOT NULL
      AND attempt.state = 'unknown'
      AND attempt.redacted_response = effect.redacted_result
      AND attempt.provider_reference IS NOT DISTINCT FROM
            effect.provider_reference
      AND attempt.error_code IS NOT DISTINCT FROM effect.error_code
      AND attempt.completed_at IS NOT NULL
      AND attempt.completed_at <= effect.completed_at
      AND effect.redacted_result->>'provider' = 'faire'
      AND effect.redacted_result->>'action' =
            'faire.product.image.publish'
      AND effect.redacted_result->>'operation' = 'productImagePublish'
      AND effect.redacted_result->>'outcome' = 'unknown'
      AND effect.redacted_result->>'deliveryGrantId' = image_grant.id::text
      AND effect.redacted_result->>'providerAttemptGlobalId' =
            attempt.global_id
      AND effect.redacted_result->>'externalProductId' =
            image_grant.external_product_id
      AND effect.redacted_result->>'assetContentSha256' =
            image_grant.asset_content_sha256
      AND effect.redacted_result->>'uploadedLocatorSha256' =
            upload.uploaded_locator_sha256
      AND effect.redacted_result->>'existingImagesPreserved' = 'true'
      AND effect.redacted_result->'priorImageCount' =
            to_jsonb(expected.prior_image_count)
      AND effect.redacted_result->'projectedImageCount' =
            to_jsonb(expected.prior_image_count + 1)
      AND effect.redacted_result->>'providerWrites' =
            effect.provider_write_count::text
      AND effect.redacted_result->>'providerWriteCountLowerBound' =
            effect.provider_write_count::text
      AND upload.stage = 'upload'
      AND upload.outcome = 'succeeded'
      AND upload.provider_write_count = 1
      AND upload.observed_at <= effect.completed_at
      AND upload.redacted_evidence->>'provider' = 'faire'
      AND upload.redacted_evidence->>'operation' = 'productImageUpload'
      AND upload.redacted_evidence->>'outcome' = 'succeeded'
      AND upload.redacted_evidence->>'assetContentSha256' =
            image_grant.asset_content_sha256
      AND upload.redacted_evidence->>'uploadedLocatorSha256' =
            upload.uploaded_locator_sha256
      AND upload.redacted_evidence->>'providerWrites' = '1'
      AND upload.evidence_hash =
            operations_faire_provider_write_request_hash(
              upload.redacted_evidence
            )
      AND resolution.stage = 'reconcile'
      AND resolution.outcome = 'observed_applied'
      AND resolution.provider_attempt_id IS NULL
      AND resolution.provider_write_count = 2
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
      AND resolution.redacted_evidence->'providerImageCount' =
            to_jsonb(expected.prior_image_count + 1)
      AND resolution.redacted_evidence->>'exactLocatorMatchCount' = '1'
      AND resolution.redacted_evidence->>'providerImageSetSha256' ~
            '^[a-f0-9]{64}$'
      AND resolution.redacted_evidence->>'providerWrites' = '2'
      AND resolution.redacted_evidence->>'reconciledBy' =
            resolution.recorded_by
      AND resolution.evidence_hash =
            operations_faire_provider_write_request_hash(
              resolution.redacted_evidence
            )
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
      AND candidate_result->'priorImageCount' =
            to_jsonb(expected.prior_image_count)
      AND candidate_result->'projectedImageCount' =
            to_jsonb(expected.prior_image_count + 1)
      AND candidate_result->>'providerWritesKnown' = 'true'
      AND candidate_result->>'providerWriteCountLowerBound' = '2'
      AND candidate_result->>'providerWrites' = '2'
      AND candidate_result->>'reconciliationStepId' = resolution.id::text
      AND candidate_result->>'reconciledFromState' = 'unknown'
      AND candidate_result->>'reconciledFromProviderWriteCount' =
            effect.provider_write_count::text
      AND candidate_result->>'reconciledFromTerminalEvidenceHash' =
            effect.terminal_evidence_hash
      AND candidate_result->>'providerImageSetSha256' =
            resolution.redacted_evidence->>'providerImageSetSha256'
      AND candidate_result->'providerImageCount' =
            to_jsonb(expected.prior_image_count + 1)
      AND candidate_result->>'exactLocatorMatchCount' = '1'
      AND candidate_result->>'reconciledBy' = resolution.recorded_by
      AND candidate_terminal_evidence_hash =
            operations_faire_provider_write_request_hash(candidate_result)
      AND candidate_provider_reference = image_grant.external_product_id
      AND candidate_provider_write_count = 2
      AND candidate_completed_at = resolution.observed_at
      AND (
        (
          effect.redacted_result->>'stage' = 'attach_dispatch_or_readback'
          AND effect.provider_write_count = 1
          AND effect.redacted_result->>'providerWritesKnown' = 'false'
        )
        OR (
          effect.redacted_result->>'stage' = 'expired_claim_reconciliation'
          AND effect.redacted_result->>'errorCode' =
                'FAIRE_PRODUCT_IMAGE_EXPIRED_CLAIM_UNKNOWN'
          AND effect.redacted_result->>'externalEffectGlobalId' =
                effect.global_id
          AND effect.redacted_result->>'uploadedLocatorAvailable' = 'true'
          AND effect.redacted_result->>'readbackEligibility' =
                'readback_terminalizable'
          AND effect.redacted_result->>'providerMutationAttempted' = 'true'
          AND effect.redacted_result->>'reconciledBy' IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM app_user_organization_memberships recovery_membership
            WHERE recovery_membership.organization_id = effect.organization_id
              AND recovery_membership.user_email =
                    effect.redacted_result->>'reconciledBy'
              AND recovery_membership.role IN ('owner', 'admin')
              AND recovery_membership.status = 'active'
          )
        )
      )
      AND (
        (
          candidate_result->>'durableEvidenceSource' = 'effect_result'
          AND effect.redacted_result->>'stage' =
                'attach_dispatch_or_readback'
          AND effect.provider_write_count = 1
          AND candidate_result ? 'durableAttachStepId'
          AND candidate_result->'durableAttachStepId' = 'null'::jsonb
          AND candidate_result ? 'durableAttachOutcome'
          AND candidate_result->'durableAttachOutcome' = 'null'::jsonb
        )
        OR (
          candidate_result->>'durableEvidenceSource' = 'attach_step'
          AND attach.id IS NOT NULL
          AND candidate_result->>'durableAttachStepId' = attach.id::text
          AND candidate_result->>'durableAttachOutcome' = attach.outcome
          AND attach.stage = 'attach'
          AND attach.uploaded_locator_sha256 =
                upload.uploaded_locator_sha256
          AND attach.observed_at <= effect.completed_at
          AND attach.redacted_evidence->>'provider' = 'faire'
          AND attach.redacted_evidence->>'operation' = 'productImageAttach'
          AND attach.redacted_evidence->>'outcome' = attach.outcome
          AND attach.redacted_evidence->>'externalProductId' =
                image_grant.external_product_id
          AND (
            attach.redacted_evidence->>'assetContentSha256' =
              image_grant.asset_content_sha256
            OR (
              attach.outcome = 'succeeded'
              AND NOT (attach.redacted_evidence ? 'assetContentSha256')
            )
          )
          AND attach.redacted_evidence->>'uploadedLocatorSha256' =
                upload.uploaded_locator_sha256
          AND attach.redacted_evidence->'priorImageCount' =
                to_jsonb(expected.prior_image_count)
          AND attach.redacted_evidence->'projectedImageCount' =
                to_jsonb(expected.prior_image_count + 1)
          AND attach.redacted_evidence->>'existingImagesPreserved' = 'true'
          AND attach.redacted_evidence->>'providerWrites' =
                attach.provider_write_count::text
          AND attach.evidence_hash =
                operations_faire_provider_write_request_hash(
                  attach.redacted_evidence
                )
          AND (
            (
              attach.outcome = 'unknown'
              AND attach.provider_write_count = 1
              AND attach.redacted_evidence->>'providerWritesKnown' = 'false'
              AND attach.redacted_evidence->>'providerWriteCountLowerBound' =
                    '1'
            )
            OR (
              attach.outcome = 'succeeded'
              AND attach.provider_write_count = 2
              AND (
                NOT (attach.redacted_evidence ? 'providerWritesKnown')
                OR attach.redacted_evidence->>'providerWritesKnown' = 'true'
              )
              AND (
                NOT (
                  attach.redacted_evidence ? 'providerWriteCountLowerBound'
                )
                OR attach.redacted_evidence->>'providerWriteCountLowerBound' =
                      '2'
              )
            )
          )
          AND (
            effect.redacted_result->>'stage' = 'attach_dispatch_or_readback'
            OR (
              effect.redacted_result->>'stage' =
                    'expired_claim_reconciliation'
              AND effect.redacted_result->>'durableAttachStepId' =
                    attach.id::text
              AND effect.redacted_result->>'durableAttachOutcome' =
                    attach.outcome
              AND effect.redacted_result->>'readbackReason' = CASE
                WHEN attach.outcome = 'unknown'
                  THEN 'exact_attach_unknown_evidence'
                ELSE 'exact_attach_succeeded_evidence'
              END
              AND effect.redacted_result->>'providerWritesKnown' = CASE
                WHEN attach.outcome = 'succeeded' THEN 'true'
                ELSE 'false'
              END
            )
          )
          AND effect.provider_write_count = attach.provider_write_count
        )
      )
  )
$$;

COMMENT ON FUNCTION
  operations_faire_product_image_exact_reconciliation_transition_is_valid(
    uuid, uuid, jsonb, text, text, integer, timestamptz
  ) IS
  'Validates the sole exact unknown-to-succeeded Faire Product-image transition from hash-exact one-write evidence or attempt-fenced one/two-write attachment evidence plus one append-only owner/admin readback.';
