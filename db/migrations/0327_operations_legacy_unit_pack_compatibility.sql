-- Migration 0321 made ordinary one-each lines independent of a Product pack,
-- but it intentionally updated only held/resolving unresolved rows. Older
-- ready/promoted lines can retain a manual package-resolution shape. Manual
-- measurements are not provider facts: normalize only measurements bound to
-- the append-only package-resolution decision and its exact succeeded command
-- result. Rows without this evidence remain fail-closed.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS
  operations_commerce_legacy_unit_measurement_evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    integration_account_id uuid NOT NULL,
    pipeline_id uuid NOT NULL,
    candidate_line_id uuid NOT NULL,
    resolution_decision_id uuid NOT NULL
      REFERENCES operations_commerce_resolution_decisions(id)
      ON DELETE RESTRICT,
    command_receipt_id uuid NOT NULL,
    measurement_source text NOT NULL
      CHECK (measurement_source = 'manual_package_resolution'),
    weight_grams integer NOT NULL CHECK (weight_grams > 0),
    length_mm integer NOT NULL CHECK (length_mm > 0),
    width_mm integer NOT NULL CHECK (width_mm > 0),
    height_mm integer NOT NULL CHECK (height_mm > 0),
    line_source_revision text NOT NULL CHECK (
      length(btrim(line_source_revision)) BETWEEN 1 AND 512
      AND line_source_revision !~ '[[:cntrl:]]'
    ),
    line_source_hash text NOT NULL
      CHECK (line_source_hash ~ '^[a-f0-9]{64}$'),
    request_hash text NOT NULL
      CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    result_payload_hash text NOT NULL
      CHECK (result_payload_hash ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operations_commerce_legacy_unit_measurement_line_unique
      UNIQUE (
        organization_id,
        integration_account_id,
        pipeline_id,
        candidate_line_id
      ),
    CONSTRAINT operations_commerce_legacy_unit_measurement_line_fkey
      FOREIGN KEY (
        organization_id,
        integration_account_id,
        pipeline_id,
        candidate_line_id
      ) REFERENCES operations_commerce_order_candidate_lines (
        organization_id,
        integration_account_id,
        pipeline_id,
        id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_commerce_legacy_unit_measurement_receipt_fkey
      FOREIGN KEY (organization_id, command_receipt_id)
      REFERENCES operations_command_receipts(organization_id, id)
      ON DELETE RESTRICT
  );

CREATE OR REPLACE FUNCTION
  validate_operations_commerce_legacy_unit_measurement_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.operations_commerce_order_candidate_lines line
    JOIN public.operations_commerce_order_candidates candidate
      ON candidate.organization_id = line.organization_id
     AND candidate.integration_account_id = line.integration_account_id
     AND candidate.pipeline_id = line.pipeline_id
     AND candidate.id = line.order_candidate_id
    JOIN public.operations_commerce_resolution_decisions decision
      ON decision.id = NEW.resolution_decision_id
     AND decision.organization_id = line.organization_id
     AND decision.integration_account_id = line.integration_account_id
     AND decision.pipeline_id = line.pipeline_id
     AND decision.target_type = 'order_candidate_line'
     AND decision.target_global_id = line.global_id
     AND decision.target_source_revision = line.source_revision
     AND decision.target_source_hash = line.source_hash
     AND decision.decision_type = 'package_resolution'
     AND decision.outcome = 'applied'
     AND decision.reason_code = 'manual_package_recorded'
     AND decision.package_profile_id IS NULL
     AND decision.command_receipt_id = NEW.command_receipt_id
     AND decision.request_hash = NEW.request_hash
    JOIN public.operations_command_receipts receipt
      ON receipt.organization_id = line.organization_id
     AND receipt.id = decision.command_receipt_id
     AND receipt.command_type = 'commerce.intake.resolve_package'
     AND receipt.request_hash = decision.request_hash
     AND receipt.status = 'succeeded'
     AND receipt.error_code IS NULL
     AND receipt.error_message IS NULL
     AND receipt.completed_at IS NOT NULL
     AND receipt.result_global_id = candidate.global_id
     AND pg_catalog.jsonb_typeof(receipt.result_payload) = 'object'
     AND receipt.result_payload->>'action' = 'resolve-package'
     AND receipt.result_payload->>'candidateGlobalId' = candidate.global_id
     AND receipt.result_payload->>'lineGlobalId' = line.global_id
     AND receipt.result_payload->>'packageSource' = 'manual'
     AND receipt.result_payload ? 'packageProfileGlobalId'
     AND receipt.result_payload->'packageProfileGlobalId' = 'null'::jsonb
     AND receipt.result_payload->'replayed' = 'false'::jsonb
     AND receipt.result_payload->'providerWrites' = '0'::jsonb
     AND receipt.result_payload->'syncCursorAdvanced' = 'false'::jsonb
     AND pg_catalog.jsonb_typeof(
           receipt.result_payload->'weightGrams'
         ) = 'number'
     AND receipt.result_payload->>'weightGrams' = line.weight_grams::text
     AND pg_catalog.jsonb_typeof(
           receipt.result_payload->'dimensionsMm'
         ) = 'object'
     AND receipt.result_payload #>> '{dimensionsMm,length}' =
           line.length_mm::text
     AND receipt.result_payload #>> '{dimensionsMm,width}' =
           line.width_mm::text
     AND receipt.result_payload #>> '{dimensionsMm,height}' =
           line.height_mm::text
    WHERE line.organization_id = NEW.organization_id
      AND line.integration_account_id = NEW.integration_account_id
      AND line.pipeline_id = NEW.pipeline_id
      AND line.id = NEW.candidate_line_id
      AND line.workflow_state IN ('ready', 'promoted')
      AND line.requires_shipping = true
      AND line.unfulfilled_quantity > 0
      AND line.unit_multiplier = 1
      AND line.mapping_state = 'resolved'
      AND line.packaging_state = 'resolved'
      AND line.packaging_source = 'manual'
      AND line.packaging_weight_source IS NULL
      AND line.weight_grams = NEW.weight_grams
      AND line.length_mm = NEW.length_mm
      AND line.width_mm = NEW.width_mm
      AND line.height_mm = NEW.height_mm
      AND line.product_id IS NOT NULL
      AND line.package_profile_id IS NULL
      AND line.commerce_variant_pack_mapping_id IS NULL
      AND line.commerce_variant_pack_mapping_row_version IS NULL
      AND line.pack_profile_version_id IS NULL
      AND line.pack_profile_version_row_version IS NULL
      AND line.pack_profile_package_level IS NULL
      AND line.pack_profile_base_each_quantity IS NULL
      AND cardinality(line.blocking_codes) = 0
      AND NEW.measurement_source = 'manual_package_resolution'
      AND NEW.line_source_revision = line.source_revision
      AND NEW.line_source_hash = line.source_hash
      AND NEW.result_payload_hash = pg_catalog.encode(
            public.digest(
              pg_catalog.convert_to(receipt.result_payload::text, 'UTF8'),
              'sha256'
            ),
            'hex'
          )
      AND NOT EXISTS (
        SELECT 1
        FROM public.operations_commerce_resolution_decisions
          competing_decision
        JOIN public.operations_command_receipts competing_receipt
          ON competing_receipt.organization_id = line.organization_id
         AND competing_receipt.id = competing_decision.command_receipt_id
         AND competing_receipt.command_type =
               'commerce.intake.resolve_package'
         AND competing_receipt.request_hash =
               competing_decision.request_hash
         AND competing_receipt.status = 'succeeded'
         AND competing_receipt.error_code IS NULL
         AND competing_receipt.error_message IS NULL
         AND competing_receipt.completed_at IS NOT NULL
         AND competing_receipt.result_global_id = candidate.global_id
        WHERE competing_decision.organization_id = line.organization_id
          AND competing_decision.integration_account_id =
                line.integration_account_id
          AND competing_decision.pipeline_id = line.pipeline_id
          AND competing_decision.target_type = 'order_candidate_line'
          AND competing_decision.target_global_id = line.global_id
          AND competing_decision.target_source_revision =
                line.source_revision
          AND competing_decision.target_source_hash = line.source_hash
          AND competing_decision.decision_type = 'package_resolution'
          AND competing_decision.outcome = 'applied'
          AND competing_decision.reason_code = 'manual_package_recorded'
          AND competing_decision.package_profile_id IS NULL
          AND (
            (
              pg_catalog.jsonb_typeof(
                competing_receipt.result_payload
              ) = 'object'
              AND competing_receipt.result_payload->>'action' =
                    'resolve-package'
              AND competing_receipt.result_payload->>'candidateGlobalId' =
                    candidate.global_id
              AND competing_receipt.result_payload->>'lineGlobalId' =
                    line.global_id
              AND competing_receipt.result_payload->>'packageSource' =
                    'manual'
              AND competing_receipt.result_payload ?
                    'packageProfileGlobalId'
              AND competing_receipt.result_payload->
                    'packageProfileGlobalId' = 'null'::jsonb
              AND competing_receipt.result_payload->'replayed' =
                    'false'::jsonb
              AND competing_receipt.result_payload->'providerWrites' =
                    '0'::jsonb
              AND competing_receipt.result_payload->
                    'syncCursorAdvanced' = 'false'::jsonb
              AND pg_catalog.jsonb_typeof(
                    competing_receipt.result_payload->'weightGrams'
                  ) = 'number'
              AND pg_catalog.jsonb_typeof(
                    competing_receipt.result_payload->'dimensionsMm'
                  ) = 'object'
              AND pg_catalog.jsonb_typeof(
                    competing_receipt.result_payload #>
                      '{dimensionsMm,length}'
                  ) = 'number'
              AND pg_catalog.jsonb_typeof(
                    competing_receipt.result_payload #>
                      '{dimensionsMm,width}'
                  ) = 'number'
              AND pg_catalog.jsonb_typeof(
                    competing_receipt.result_payload #>
                      '{dimensionsMm,height}'
                  ) = 'number'
              AND competing_receipt.result_payload->>'weightGrams' =
                    line.weight_grams::text
              AND competing_receipt.result_payload #>>
                    '{dimensionsMm,length}' = line.length_mm::text
              AND competing_receipt.result_payload #>>
                    '{dimensionsMm,width}' = line.width_mm::text
              AND competing_receipt.result_payload #>>
                    '{dimensionsMm,height}' = line.height_mm::text
              AND pg_catalog.encode(
                    public.digest(
                      pg_catalog.convert_to(
                        competing_receipt.result_payload::text,
                        'UTF8'
                      ),
                      'sha256'
                    ),
                    'hex'
                  ) = NEW.result_payload_hash
            ) IS NOT TRUE
          )
      )
  ) THEN
    RAISE EXCEPTION
      'Legacy unit measurement evidence requires one exact manual package-resolution result';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_operations_commerce_legacy_unit_measurement_evidence
  ON operations_commerce_legacy_unit_measurement_evidence;
CREATE TRIGGER
  validate_operations_commerce_legacy_unit_measurement_evidence
BEFORE INSERT ON operations_commerce_legacy_unit_measurement_evidence
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_commerce_legacy_unit_measurement_evidence();

CREATE OR REPLACE FUNCTION
  protect_operations_commerce_legacy_unit_measurement_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Legacy unit measurement evidence is append-only';
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_commerce_legacy_unit_measurement_evidence
  ON operations_commerce_legacy_unit_measurement_evidence;
CREATE TRIGGER
  protect_operations_commerce_legacy_unit_measurement_evidence
BEFORE UPDATE OR DELETE
ON operations_commerce_legacy_unit_measurement_evidence
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_legacy_unit_measurement_evidence();

-- More than one replay-safe command may have recorded the same historical
-- measurement. Accept duplicates only when both the normalized measurement
-- tuple and the complete jsonb result digest agree. Any conflicting result for
-- the exact line source revision, including a malformed successful result,
-- leaves the line untouched and fail-closed.
WITH base_qualified_manual_evidence AS MATERIALIZED (
  SELECT
    line.organization_id,
    line.integration_account_id,
    line.pipeline_id,
    line.id AS candidate_line_id,
    line.global_id AS line_global_id,
    candidate.global_id AS candidate_global_id,
    line.weight_grams AS line_weight_grams,
    line.length_mm AS line_length_mm,
    line.width_mm AS line_width_mm,
    line.height_mm AS line_height_mm,
    line.source_revision AS line_source_revision,
    line.source_hash AS line_source_hash,
    decision.id AS resolution_decision_id,
    decision.created_at AS resolution_decision_created_at,
    receipt.id AS command_receipt_id,
    receipt.result_payload,
    decision.request_hash,
    pg_catalog.encode(
      public.digest(
        pg_catalog.convert_to(receipt.result_payload::text, 'UTF8'),
        'sha256'
      ),
      'hex'
    ) AS result_payload_hash
  FROM operations_commerce_order_candidate_lines line
  JOIN operations_commerce_order_candidates candidate
    ON candidate.organization_id = line.organization_id
   AND candidate.integration_account_id = line.integration_account_id
   AND candidate.pipeline_id = line.pipeline_id
   AND candidate.id = line.order_candidate_id
  JOIN operations_commerce_resolution_decisions decision
    ON decision.organization_id = line.organization_id
   AND decision.integration_account_id = line.integration_account_id
   AND decision.pipeline_id = line.pipeline_id
   AND decision.target_type = 'order_candidate_line'
   AND decision.target_global_id = line.global_id
   AND decision.target_source_revision = line.source_revision
   AND decision.target_source_hash = line.source_hash
   AND decision.decision_type = 'package_resolution'
   AND decision.outcome = 'applied'
   AND decision.reason_code = 'manual_package_recorded'
   AND decision.package_profile_id IS NULL
  JOIN operations_command_receipts receipt
    ON receipt.organization_id = line.organization_id
   AND receipt.id = decision.command_receipt_id
   AND receipt.command_type = 'commerce.intake.resolve_package'
   AND receipt.request_hash = decision.request_hash
   AND receipt.status = 'succeeded'
   AND receipt.error_code IS NULL
   AND receipt.error_message IS NULL
   AND receipt.completed_at IS NOT NULL
   AND receipt.result_global_id = candidate.global_id
  WHERE line.workflow_state IN ('ready', 'promoted')
    AND line.requires_shipping = true
    AND line.unfulfilled_quantity > 0
    AND line.unit_multiplier = 1
    AND line.mapping_state = 'resolved'
    AND line.packaging_state = 'resolved'
    AND line.packaging_source = 'manual'
    AND line.packaging_weight_source IS NULL
    AND line.weight_grams > 0
    AND line.length_mm > 0
    AND line.width_mm > 0
    AND line.height_mm > 0
    AND line.product_id IS NOT NULL
    AND line.package_profile_id IS NULL
    AND line.commerce_variant_pack_mapping_id IS NULL
    AND line.commerce_variant_pack_mapping_row_version IS NULL
    AND line.pack_profile_version_id IS NULL
    AND line.pack_profile_version_row_version IS NULL
    AND line.pack_profile_package_level IS NULL
    AND line.pack_profile_base_each_quantity IS NULL
    AND cardinality(line.blocking_codes) = 0
),
structurally_qualified_manual_evidence AS MATERIALIZED (
  SELECT
    evidence.organization_id,
    evidence.integration_account_id,
    evidence.pipeline_id,
    evidence.candidate_line_id,
    evidence.line_weight_grams,
    evidence.line_length_mm,
    evidence.line_width_mm,
    evidence.line_height_mm,
    evidence.line_source_revision,
    evidence.line_source_hash,
    evidence.resolution_decision_id,
    evidence.resolution_decision_created_at,
    evidence.command_receipt_id,
    evidence.result_payload->>'weightGrams' AS evidence_weight_grams,
    evidence.result_payload #>> '{dimensionsMm,length}'
      AS evidence_length_mm,
    evidence.result_payload #>> '{dimensionsMm,width}'
      AS evidence_width_mm,
    evidence.result_payload #>> '{dimensionsMm,height}'
      AS evidence_height_mm,
    evidence.request_hash,
    evidence.result_payload_hash
  FROM base_qualified_manual_evidence evidence
  WHERE pg_catalog.jsonb_typeof(evidence.result_payload) = 'object'
    AND evidence.result_payload->>'action' = 'resolve-package'
    AND evidence.result_payload->>'candidateGlobalId' =
          evidence.candidate_global_id
    AND evidence.result_payload->>'lineGlobalId' = evidence.line_global_id
    AND evidence.result_payload->>'packageSource' = 'manual'
    AND evidence.result_payload ? 'packageProfileGlobalId'
    AND evidence.result_payload->'packageProfileGlobalId' = 'null'::jsonb
    AND evidence.result_payload->'replayed' = 'false'::jsonb
    AND evidence.result_payload->'providerWrites' = '0'::jsonb
    AND evidence.result_payload->'syncCursorAdvanced' = 'false'::jsonb
    AND pg_catalog.jsonb_typeof(
          evidence.result_payload->'weightGrams'
        ) = 'number'
    AND pg_catalog.jsonb_typeof(
          evidence.result_payload->'dimensionsMm'
        ) = 'object'
    AND pg_catalog.jsonb_typeof(
          evidence.result_payload #> '{dimensionsMm,length}'
        ) = 'number'
    AND pg_catalog.jsonb_typeof(
          evidence.result_payload #> '{dimensionsMm,width}'
        ) = 'number'
    AND pg_catalog.jsonb_typeof(
          evidence.result_payload #> '{dimensionsMm,height}'
        ) = 'number'
),
admissible_manual_lines AS MATERIALIZED (
  SELECT
    evidence.organization_id,
    evidence.integration_account_id,
    evidence.pipeline_id,
    evidence.candidate_line_id
  FROM structurally_qualified_manual_evidence evidence
  JOIN (
    SELECT
      base.organization_id,
      base.integration_account_id,
      base.pipeline_id,
      base.candidate_line_id,
      count(*) AS base_evidence_count
    FROM base_qualified_manual_evidence base
    GROUP BY
      base.organization_id,
      base.integration_account_id,
      base.pipeline_id,
      base.candidate_line_id
  ) base_counts
    ON base_counts.organization_id = evidence.organization_id
   AND base_counts.integration_account_id = evidence.integration_account_id
   AND base_counts.pipeline_id = evidence.pipeline_id
   AND base_counts.candidate_line_id = evidence.candidate_line_id
  GROUP BY
    evidence.organization_id,
    evidence.integration_account_id,
    evidence.pipeline_id,
    evidence.candidate_line_id
  HAVING count(*) = min(base_counts.base_evidence_count)
     AND count(DISTINCT ROW(
           evidence.evidence_weight_grams,
           evidence.evidence_length_mm,
           evidence.evidence_width_mm,
           evidence.evidence_height_mm
         )) = 1
     AND count(DISTINCT evidence.result_payload_hash) = 1
),
exact_manual_evidence AS MATERIALIZED (
  SELECT DISTINCT ON (
    evidence.organization_id,
    evidence.integration_account_id,
    evidence.pipeline_id,
    evidence.candidate_line_id
  )
    evidence.organization_id,
    evidence.integration_account_id,
    evidence.pipeline_id,
    evidence.candidate_line_id,
    evidence.resolution_decision_id,
    evidence.command_receipt_id,
    evidence.line_weight_grams AS weight_grams,
    evidence.line_length_mm AS length_mm,
    evidence.line_width_mm AS width_mm,
    evidence.line_height_mm AS height_mm,
    evidence.line_source_revision,
    evidence.line_source_hash,
    evidence.request_hash,
    evidence.result_payload_hash
  FROM structurally_qualified_manual_evidence evidence
  JOIN admissible_manual_lines admissible
    ON admissible.organization_id = evidence.organization_id
   AND admissible.integration_account_id = evidence.integration_account_id
   AND admissible.pipeline_id = evidence.pipeline_id
   AND admissible.candidate_line_id = evidence.candidate_line_id
  WHERE evidence.evidence_weight_grams =
          evidence.line_weight_grams::text
    AND evidence.evidence_length_mm = evidence.line_length_mm::text
    AND evidence.evidence_width_mm = evidence.line_width_mm::text
    AND evidence.evidence_height_mm = evidence.line_height_mm::text
  ORDER BY
    evidence.organization_id,
    evidence.integration_account_id,
    evidence.pipeline_id,
    evidence.candidate_line_id,
    evidence.resolution_decision_created_at DESC,
    evidence.resolution_decision_id DESC
)
INSERT INTO operations_commerce_legacy_unit_measurement_evidence (
  organization_id,
  integration_account_id,
  pipeline_id,
  candidate_line_id,
  resolution_decision_id,
  command_receipt_id,
  measurement_source,
  weight_grams,
  length_mm,
  width_mm,
  height_mm,
  line_source_revision,
  line_source_hash,
  request_hash,
  result_payload_hash
)
SELECT
  evidence.organization_id,
  evidence.integration_account_id,
  evidence.pipeline_id,
  evidence.candidate_line_id,
  evidence.resolution_decision_id,
  evidence.command_receipt_id,
  'manual_package_resolution',
  evidence.weight_grams,
  evidence.length_mm,
  evidence.width_mm,
  evidence.height_mm,
  evidence.line_source_revision,
  evidence.line_source_hash,
  evidence.request_hash,
  evidence.result_payload_hash
FROM exact_manual_evidence evidence
ON CONFLICT (
  organization_id,
  integration_account_id,
  pipeline_id,
  candidate_line_id
) DO NOTHING;

UPDATE operations_commerce_order_candidate_lines line
SET packaging_state = 'not_required',
    packaging_source = 'none',
    row_version = line.row_version + 1,
    updated_by = 'migration-0327@clawpilot.local',
    updated_at = now()
FROM operations_commerce_legacy_unit_measurement_evidence evidence
WHERE evidence.organization_id = line.organization_id
  AND evidence.integration_account_id = line.integration_account_id
  AND evidence.pipeline_id = line.pipeline_id
  AND evidence.candidate_line_id = line.id
  AND evidence.measurement_source = 'manual_package_resolution'
  AND evidence.weight_grams = line.weight_grams
  AND evidence.length_mm = line.length_mm
  AND evidence.width_mm = line.width_mm
  AND evidence.height_mm = line.height_mm
  AND evidence.line_source_revision = line.source_revision
  AND evidence.line_source_hash = line.source_hash
  AND line.workflow_state IN ('ready', 'promoted')
  AND line.requires_shipping = true
  AND line.unfulfilled_quantity > 0
  AND line.unit_multiplier = 1
  AND line.mapping_state = 'resolved'
  AND line.packaging_state = 'resolved'
  AND line.packaging_source = 'manual'
  AND line.packaging_weight_source IS NULL
  AND line.product_id IS NOT NULL
  AND line.package_profile_id IS NULL
  AND line.commerce_variant_pack_mapping_id IS NULL
  AND line.commerce_variant_pack_mapping_row_version IS NULL
  AND line.pack_profile_version_id IS NULL
  AND line.pack_profile_version_row_version IS NULL
  AND line.pack_profile_package_level IS NULL
  AND line.pack_profile_base_each_quantity IS NULL
  AND cardinality(line.blocking_codes) = 0;

CREATE OR REPLACE FUNCTION
  protect_operations_commerce_legacy_unit_measurement_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.operations_commerce_legacy_unit_measurement_evidence evidence
    JOIN public.operations_commerce_order_candidate_lines line
      ON line.organization_id = evidence.organization_id
     AND line.integration_account_id = evidence.integration_account_id
     AND line.pipeline_id = evidence.pipeline_id
     AND line.id = evidence.candidate_line_id
    LEFT JOIN public.operations_commerce_resolution_decisions decision
      ON decision.organization_id = evidence.organization_id
     AND decision.integration_account_id = evidence.integration_account_id
     AND decision.pipeline_id = evidence.pipeline_id
     AND decision.command_receipt_id = OLD.id
     AND decision.target_type = 'order_candidate_line'
     AND decision.target_global_id = line.global_id
     AND decision.target_source_revision = evidence.line_source_revision
     AND decision.target_source_hash = evidence.line_source_hash
     AND decision.decision_type = 'package_resolution'
     AND decision.outcome = 'applied'
     AND decision.reason_code = 'manual_package_recorded'
     AND decision.package_profile_id IS NULL
    WHERE evidence.organization_id = OLD.organization_id
      AND (
        evidence.command_receipt_id = OLD.id
        OR decision.id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'A legacy unit measurement receipt referenced by immutable evidence cannot change';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_commerce_legacy_unit_measurement_receipt
  ON operations_command_receipts;
CREATE TRIGGER
  protect_operations_commerce_legacy_unit_measurement_receipt
BEFORE UPDATE OR DELETE ON operations_command_receipts
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_legacy_unit_measurement_receipt();

COMMENT ON TABLE
  operations_commerce_legacy_unit_measurement_evidence IS
  'Immutable compatibility evidence for a legacy one-each manual package-resolution result. It authenticates retained order-specific weight without treating the manual measurement as a provider or Product-pack fact.';
