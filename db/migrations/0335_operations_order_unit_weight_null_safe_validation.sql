-- PostgreSQL three-valued logic makes NOT (NULL = ... AND NULL > 0)
-- evaluate to NULL. Ordinary-unit lines without any provider weight therefore
-- failed the first operator-recorded unit-weight insert even though the read
-- workspace correctly classified them as missing. Keep the provider-evidence
-- fence, but make the absence of provider evidence explicitly null-safe.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.validate_operations_order_unit_weight_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior public.operations_order_unit_weight_facts%ROWTYPE;
BEGIN
  IF NEW.fact_hash IS DISTINCT FROM pg_catalog.encode(
    public.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'candidateGlobalId', (
            SELECT candidate.global_id
            FROM public.operations_commerce_order_candidates candidate
            WHERE candidate.id = NEW.candidate_id
          ),
          'candidateRowVersion', NEW.candidate_row_version,
          'factGlobalId', NEW.global_id,
          'factVersion', NEW.fact_version,
          'lineGlobalId', NEW.planning_line_global_id,
          'lineSourceHash', NEW.line_source_hash,
          'lineSourceRevision', NEW.line_source_revision,
          'unitWeightGrams', NEW.unit_weight_grams
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ) THEN
    RAISE EXCEPTION 'Order unit weight fact hash is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.operations_commerce_current_planning_lines line
    JOIN public.operations_commerce_order_candidates candidate
      ON candidate.organization_id = line.organization_id
     AND candidate.id = line.order_candidate_id
    JOIN public.operations_orders order_row
      ON order_row.organization_id = candidate.organization_id
     AND order_row.id = candidate.canonical_order_id
    JOIN public.operations_current_order_lines order_line
      ON order_line.organization_id = order_row.organization_id
     AND order_line.order_id = order_row.id
     AND order_line.id = line.canonical_order_line_id
    LEFT JOIN public.operations_commerce_order_revision_application_lines
      revision_line
      ON revision_line.organization_id = line.organization_id
     AND revision_line.integration_account_id = line.integration_account_id
     AND revision_line.pipeline_id = line.pipeline_id
     AND revision_line.application_id =
           candidate.accepted_revision_application_id
     AND revision_line.planning_line_id = line.id
     AND revision_line.planning_global_id = line.global_id
     AND revision_line.active = true
    LEFT JOIN public.operations_product_channel_states channel_state
      ON channel_state.organization_id = line.organization_id
     AND channel_state.integration_account_id = line.integration_account_id
     AND channel_state.pipeline_id = line.pipeline_id
     AND channel_state.provider = line.provider
     AND channel_state.external_product_id = line.external_product_id
     AND channel_state.external_variant_id = line.external_variant_id
     AND channel_state.product_id = line.product_id
     AND channel_state.product_mapping_id = line.product_mapping_id
    WHERE line.organization_id = NEW.organization_id
      AND line.integration_account_id = NEW.integration_account_id
      AND line.pipeline_id = NEW.pipeline_id
      AND line.order_candidate_id = NEW.candidate_id
      AND line.id = NEW.planning_line_id
      AND line.global_id = NEW.planning_line_global_id
      AND line.source_revision = NEW.line_source_revision
      AND line.source_hash = NEW.line_source_hash
      AND line.canonical_order_line_id = NEW.order_line_id
      AND (
        (
          candidate.accepted_revision_application_id IS NULL
          AND NEW.candidate_line_id = line.id
          AND NEW.revision_application_line_id IS NULL
        ) OR (
          candidate.accepted_revision_application_id IS NOT NULL
          AND NEW.candidate_line_id IS NULL
          AND NEW.revision_application_line_id = revision_line.id
        )
      )
      AND candidate.workflow_state = 'promoted'
      AND candidate.row_version = NEW.candidate_row_version
      AND candidate.canonical_order_id = NEW.order_id
      AND order_row.status IN ('imported', 'validated', 'held')
      AND line.workflow_state = 'promoted'
      AND line.requires_shipping = true
      AND line.unfulfilled_quantity > 0
      AND line.unit_multiplier = 1
      AND line.mapping_state = 'resolved'
      AND line.product_id IS NOT NULL
      AND line.product_mapping_id IS NOT NULL
      AND line.packaging_state = 'not_required'
      AND line.packaging_source = 'none'
      AND line.commerce_variant_pack_mapping_id IS NULL
      AND line.pack_profile_version_id IS NULL
      AND (
        NEW.fact_version > 1
        OR (
          (
            line.packaging_weight_source IS DISTINCT FROM 'provider_order'
            OR COALESCE(line.weight_grams, 0) <= 0
          )
          AND COALESCE(channel_state.weight_grams, 0) = 0
        )
      )
      AND length(pg_catalog.btrim(line.source_revision)) > 0
      AND line.source_hash ~ '^[a-f0-9]{64}$'
  ) THEN
    RAISE EXCEPTION
      'Order unit weight requires one current exact ordinary-unit line';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.operations_command_receipts receipt
    JOIN public.operations_commerce_order_candidates candidate
      ON candidate.organization_id = receipt.organization_id
     AND candidate.id = NEW.candidate_id
    WHERE receipt.organization_id = NEW.organization_id
      AND receipt.id = NEW.command_receipt_id
      AND receipt.command_type = 'operations.record_order_unit_weights'
      AND receipt.status = 'processing'
      AND receipt.request_hash = NEW.request_hash
      AND receipt.target_global_id = candidate.global_id
      AND receipt.actor_email = NEW.recorded_by
  ) THEN
    RAISE EXCEPTION
      'Order unit weight requires its exact processing command receipt';
  END IF;

  IF NEW.fact_version = 1 THEN
    IF NEW.supersedes_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'First order unit weight fact cannot supersede another fact';
    END IF;
  ELSE
    SELECT * INTO prior
    FROM public.operations_order_unit_weight_facts fact
    WHERE fact.id = NEW.supersedes_fact_id
    FOR SHARE;
    IF NOT FOUND
      OR prior.organization_id IS DISTINCT FROM NEW.organization_id
      OR prior.candidate_id IS DISTINCT FROM NEW.candidate_id
      OR prior.candidate_line_id IS DISTINCT FROM NEW.candidate_line_id
      OR prior.revision_application_line_id IS DISTINCT FROM
           NEW.revision_application_line_id
      OR prior.planning_line_global_id IS DISTINCT FROM NEW.planning_line_global_id
      OR prior.line_source_revision IS DISTINCT FROM NEW.line_source_revision
      OR prior.line_source_hash IS DISTINCT FROM NEW.line_source_hash
      OR prior.fact_version + 1 IS DISTINCT FROM NEW.fact_version
      OR EXISTS (
        SELECT 1
        FROM public.operations_order_unit_weight_facts newer
        WHERE newer.supersedes_fact_id = prior.id
      )
    THEN
      RAISE EXCEPTION
        'Order unit weight correction must extend the latest exact fact';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
