-- Tighten customer/measured packaging-dimension authority before runtime
-- commerce-variant pack association is activated. Application validation
-- already requires a reference; PostgreSQL must enforce the same fact.

ALTER TABLE operations_packaging_materials
  DROP CONSTRAINT IF EXISTS
    operations_packaging_materials_dimension_evidence_valid;

ALTER TABLE operations_packaging_materials
  ADD CONSTRAINT operations_packaging_materials_dimension_evidence_valid
  CHECK (
    dimension_evidence_type IN (
      'unknown', 'customer_confirmed', 'measured', 'provider', 'legacy'
    )
    AND (
      dimension_evidence_reference IS NULL
      OR length(btrim(dimension_evidence_reference)) BETWEEN 1 AND 500
    )
    AND (
      dimension_evidence_type NOT IN ('customer_confirmed', 'measured')
      OR (
        dimension_confirmed_at IS NOT NULL
        AND dimension_evidence_reference IS NOT NULL
        AND length(btrim(dimension_evidence_reference)) BETWEEN 1 AND 500
      )
    )
  );

COMMENT ON CONSTRAINT
  operations_packaging_materials_dimension_evidence_valid
  ON operations_packaging_materials IS
  'Customer-confirmed and measured dimensions require a timestamped, nonblank evidence reference; other evidence types may omit a reference.';
