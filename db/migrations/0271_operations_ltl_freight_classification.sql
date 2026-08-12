-- Immutable, operator-attested shipment density evidence for LTL rating.
--
-- This implements the public NMFTA 13-subprovision full-density scale as a
-- recommendation only. It does not contain or reproduce the NMFC item
-- database. A row can authorize density_calculation evidence only after an
-- operator confirms that the commodity uses the full scale and has no
-- handling, stowability, liability, or mixed-commodity exception.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES (
  'gfca',
  'operations.ltl_freight_class_assessment',
  'LTL freight-class assessment'
)
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_ltl_freight_class_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gfca'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  input_hash text NOT NULL,
  contract_version text NOT NULL,
  handling_unit_key text NOT NULL,
  description text NOT NULL,
  length_mm integer NOT NULL CHECK (length_mm BETWEEN 1 AND 10000),
  width_mm integer NOT NULL CHECK (width_mm BETWEEN 1 AND 10000),
  height_mm integer NOT NULL CHECK (height_mm BETWEEN 1 AND 10000),
  gross_weight_grams bigint NOT NULL
    CHECK (gross_weight_grams BETWEEN 1 AND 100000000),
  volume_cubic_feet numeric(20,6) NOT NULL CHECK (volume_cubic_feet > 0),
  density_pcf numeric(20,6) NOT NULL CHECK (density_pcf > 0),
  recommended_freight_class numeric(4,1) NOT NULL,
  full_density_scale_confirmed boolean NOT NULL,
  mixed_commodities boolean NOT NULL,
  handling_concern boolean NOT NULL,
  stowability_concern boolean NOT NULL,
  liability_concern boolean NOT NULL,
  classification_reference text NOT NULL,
  nmfc_code text,
  attestation text NOT NULL,
  classification_evidence jsonb NOT NULL,
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT operations_ltl_freight_class_assessment_global_valid CHECK (
    global_id ~ '^gfca(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_ltl_freight_class_assessment_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_ltl_freight_class_assessment_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_ltl_freight_class_assessment_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_ltl_freight_class_assessment_idempotency_unique
    UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_ltl_freight_class_assessment_text_valid CHECK (
    length(idempotency_key) BETWEEN 16 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
    AND request_hash ~ '^[a-f0-9]{64}$'
    AND input_hash ~ '^[a-f0-9]{64}$'
    AND contract_version = 'clawpilot.ltl_density_classification.v1'
    AND handling_unit_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
    AND length(btrim(description)) BETWEEN 3 AND 160
    AND length(btrim(classification_reference)) BETWEEN 3 AND 120
    AND length(btrim(attestation)) BETWEEN 10 AND 120
    AND (
      nmfc_code IS NULL
      OR nmfc_code ~ '^[0-9]{3,6}(-[0-9]{1,2})?$'
    )
  ),
  CONSTRAINT operations_ltl_freight_class_assessment_class_valid CHECK (
    recommended_freight_class IN (
      50, 55, 60, 65, 70, 85, 92.5, 100, 125, 175, 250, 300, 400
    )
  ),
  CONSTRAINT operations_ltl_freight_class_assessment_eligibility_valid CHECK (
    full_density_scale_confirmed
    AND NOT mixed_commodities
    AND NOT handling_concern
    AND NOT stowability_concern
    AND NOT liability_concern
  ),
  CONSTRAINT operations_ltl_freight_class_assessment_evidence_valid CHECK (
    COALESCE(
      operations_transport_classification_evidence_is_valid(
        classification_evidence,
        recommended_freight_class,
        nmfc_code
      )
      AND classification_evidence->>'source' = 'density_calculation'
      AND classification_evidence->>'reference' = global_id,
      false
    )
  )
);

COMMENT ON TABLE operations_ltl_freight_class_assessments IS
  'Append-only operator attestation that an exact as-tendered LTL handling unit is eligible for the public 13-band density scale; it is not an NMFC item database or a general commodity classifier.';

ALTER TABLE operations_outbound_handling_unit_commodities
  ADD COLUMN IF NOT EXISTS classification_assessment_id uuid,
  DROP CONSTRAINT IF EXISTS
    operations_outbound_handling_commodity_class_assessment_fkey,
  ADD CONSTRAINT operations_outbound_handling_commodity_class_assessment_fkey
    FOREIGN KEY (organization_id, classification_assessment_id)
    REFERENCES operations_ltl_freight_class_assessments(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS
    operations_outbound_handling_commodity_class_assessment_required,
  ADD CONSTRAINT
    operations_outbound_handling_commodity_class_assessment_required CHECK (
      COALESCE(
        jsonb_typeof(classification_evidence) = 'object'
        AND jsonb_typeof(classification_evidence->'source') = 'string'
        AND (
          (classification_evidence->>'source' = 'density_calculation')
            = (classification_assessment_id IS NOT NULL)
        ),
        false
      )
    );

CREATE OR REPLACE FUNCTION validate_operations_outbound_handling_commodity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_outbound_handling_units unit
    WHERE unit.organization_id = NEW.organization_id
      AND unit.handling_unit_plan_id = NEW.handling_unit_plan_id
      AND unit.id = NEW.handling_unit_id
      AND unit.unit_type = 'pallet'
  ) THEN
    RAISE EXCEPTION
      'Outbound handling commodities require their exact pallet unit';
  END IF;

  IF NEW.classification_assessment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM operations_ltl_freight_class_assessments assessment
    JOIN operations_outbound_handling_units unit
      ON unit.organization_id = assessment.organization_id
     AND unit.handling_unit_plan_id = NEW.handling_unit_plan_id
     AND unit.id = NEW.handling_unit_id
     AND unit.unit_type = 'pallet'
     AND unit.mixed_commodities = false
     AND unit.length_mm = assessment.length_mm
     AND unit.width_mm = assessment.width_mm
     AND unit.height_mm = assessment.height_mm
     AND unit.gross_weight_grams = assessment.gross_weight_grams
    WHERE assessment.organization_id = NEW.organization_id
      AND assessment.id = NEW.classification_assessment_id
      AND assessment.recommended_freight_class = NEW.freight_class
      AND assessment.nmfc_code IS NOT DISTINCT FROM NEW.nmfc_code
      AND assessment.global_id = NEW.classification_evidence->>'reference'
      AND assessment.classification_evidence = NEW.classification_evidence
  ) THEN
    RAISE EXCEPTION
      'Density classification must bind the exact attested single-commodity pallet';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_operations_ltl_freight_class_assessment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'LTL freight-class assessments are immutable';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_ltl_freight_class_assessment_write
  ON operations_ltl_freight_class_assessments;
CREATE TRIGGER protect_operations_ltl_freight_class_assessment_write
BEFORE UPDATE OR DELETE ON operations_ltl_freight_class_assessments
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_ltl_freight_class_assessment();
