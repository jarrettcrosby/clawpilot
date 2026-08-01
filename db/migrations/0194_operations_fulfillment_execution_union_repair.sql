-- The deferred fulfillment-execution validator installed by 0177 combined
-- canonical/run comparisons and execution-edge comparisons in the same UNION.
-- Those result sets intentionally have different shapes, so PostgreSQL rejected
-- every otherwise-valid execution at commit time before the invariant could be
-- evaluated. Keep each bidirectional EXCEPT independent and collapse the
-- result to the same non-zero mismatch signal consumed by the validator.

DO $migration$
DECLARE
  current_definition text;
  revised_definition text;
  line_start integer;
  line_end integer;
  package_start integer;
  package_end integer;
  current_line_comparison text;
  current_package_comparison text;
  line_repair constant text := $line$  SELECT count(*) INTO line_mismatch_count
  FROM (
    SELECT 1 AS mismatch
    FROM (
      (
        SELECT
          order_line.global_id,
          product.reference_code,
          order_line.quantity
        FROM operations_order_lines order_line
        JOIN crm_products product
          ON product.pipeline_id = order_line.pipeline_id
         AND product.id = order_line.product_id
        WHERE order_line.organization_id = execution.organization_id
          AND order_line.order_id = execution.order_id
        EXCEPT
        SELECT
          run_line.line_key,
          run_line.product_key,
          run_line.required_quantity::numeric
        FROM operations_pack_rate_run_lines run_line
        WHERE run_line.organization_id = execution.organization_id
          AND run_line.run_id = execution.fulfillment_pack_rate_run_id
      )
      UNION ALL
      (
        SELECT
          run_line.line_key,
          run_line.product_key,
          run_line.required_quantity::numeric
        FROM operations_pack_rate_run_lines run_line
        WHERE run_line.organization_id = execution.organization_id
          AND run_line.run_id = execution.fulfillment_pack_rate_run_id
        EXCEPT
        SELECT
          order_line.global_id,
          product.reference_code,
          order_line.quantity
        FROM operations_order_lines order_line
        JOIN crm_products product
          ON product.pipeline_id = order_line.pipeline_id
         AND product.id = order_line.product_id
        WHERE order_line.organization_id = execution.organization_id
          AND order_line.order_id = execution.order_id
      )
    ) canonical_line_mismatch
    UNION ALL
    SELECT 1 AS mismatch
    FROM (
      (
        SELECT
          edge.order_line_id,
          edge.line_key,
          edge.product_key,
          edge.required_quantity
        FROM operations_fulfillment_execution_lines edge
        WHERE edge.organization_id = execution.organization_id
          AND edge.execution_id = execution.id
        EXCEPT
        SELECT
          order_line.id,
          order_line.global_id,
          product.reference_code,
          order_line.quantity
        FROM operations_order_lines order_line
        JOIN crm_products product
          ON product.pipeline_id = order_line.pipeline_id
         AND product.id = order_line.product_id
        WHERE order_line.organization_id = execution.organization_id
          AND order_line.order_id = execution.order_id
      )
      UNION ALL
      (
        SELECT
          order_line.id,
          order_line.global_id,
          product.reference_code,
          order_line.quantity
        FROM operations_order_lines order_line
        JOIN crm_products product
          ON product.pipeline_id = order_line.pipeline_id
         AND product.id = order_line.product_id
        WHERE order_line.organization_id = execution.organization_id
          AND order_line.order_id = execution.order_id
        EXCEPT
        SELECT
          edge.order_line_id,
          edge.line_key,
          edge.product_key,
          edge.required_quantity
        FROM operations_fulfillment_execution_lines edge
        WHERE edge.organization_id = execution.organization_id
          AND edge.execution_id = execution.id
      )
    ) execution_line_mismatch
  ) mismatch;

$line$;
  package_repair constant text := $package$  SELECT count(*) INTO package_mismatch_count
  FROM (
    SELECT 1 AS mismatch
    FROM (
      (
        SELECT
          package.evidence_package_key,
          package.package_number,
          material.code,
          material.name,
          package.length_mm,
          package.width_mm,
          package.height_mm,
          evidence_package.content_weight_grams,
          evidence_package.tare_weight_grams,
          package.weight_grams
        FROM operations_packages package
        JOIN operations_cartonization_rate_evidence_packages
          evidence_package
          ON evidence_package.organization_id = package.organization_id
         AND evidence_package.evidence_id = package.cartonization_evidence_id
         AND evidence_package.package_key = package.evidence_package_key
        JOIN operations_packaging_materials material
          ON material.organization_id = evidence_package.organization_id
         AND material.id = evidence_package.packaging_material_id
        WHERE package.organization_id = execution.organization_id
          AND package.plan_id = execution.plan_id
          AND package.status = 'packed'
        EXCEPT
        SELECT
          run_package.package_key,
          run_package.package_sequence,
          run_package.material_code,
          run_package.material_name,
          run_package.length_mm,
          run_package.width_mm,
          run_package.height_mm,
          run_package.content_weight_grams,
          run_package.tare_weight_grams,
          run_package.gross_weight_grams
        FROM operations_pack_rate_run_packages run_package
        WHERE run_package.organization_id = execution.organization_id
          AND run_package.run_id = execution.fulfillment_pack_rate_run_id
      )
      UNION ALL
      (
        SELECT
          run_package.package_key,
          run_package.package_sequence,
          run_package.material_code,
          run_package.material_name,
          run_package.length_mm,
          run_package.width_mm,
          run_package.height_mm,
          run_package.content_weight_grams,
          run_package.tare_weight_grams,
          run_package.gross_weight_grams
        FROM operations_pack_rate_run_packages run_package
        WHERE run_package.organization_id = execution.organization_id
          AND run_package.run_id = execution.fulfillment_pack_rate_run_id
        EXCEPT
        SELECT
          package.evidence_package_key,
          package.package_number,
          material.code,
          material.name,
          package.length_mm,
          package.width_mm,
          package.height_mm,
          evidence_package.content_weight_grams,
          evidence_package.tare_weight_grams,
          package.weight_grams
        FROM operations_packages package
        JOIN operations_cartonization_rate_evidence_packages
          evidence_package
          ON evidence_package.organization_id = package.organization_id
         AND evidence_package.evidence_id = package.cartonization_evidence_id
         AND evidence_package.package_key = package.evidence_package_key
        JOIN operations_packaging_materials material
          ON material.organization_id = evidence_package.organization_id
         AND material.id = evidence_package.packaging_material_id
        WHERE package.organization_id = execution.organization_id
          AND package.plan_id = execution.plan_id
          AND package.status = 'packed'
      )
    ) canonical_package_mismatch
    UNION ALL
    SELECT 1 AS mismatch
    FROM (
      (
        SELECT edge.package_id, edge.package_key
        FROM operations_fulfillment_execution_packages edge
        WHERE edge.organization_id = execution.organization_id
          AND edge.execution_id = execution.id
          AND edge.shipment_group_id = group_row.id
        EXCEPT
        SELECT package.id, package.evidence_package_key
        FROM operations_packages package
        WHERE package.organization_id = execution.organization_id
          AND package.plan_id = execution.plan_id
          AND package.status = 'packed'
      )
      UNION ALL
      (
        SELECT package.id, package.evidence_package_key
        FROM operations_packages package
        WHERE package.organization_id = execution.organization_id
          AND package.plan_id = execution.plan_id
          AND package.status = 'packed'
        EXCEPT
        SELECT edge.package_id, edge.package_key
        FROM operations_fulfillment_execution_packages edge
        WHERE edge.organization_id = execution.organization_id
          AND edge.execution_id = execution.id
          AND edge.shipment_group_id = group_row.id
      )
    ) execution_package_mismatch
  ) mismatch;

$package$;
BEGIN
  SELECT pg_get_functiondef(
    'validate_operations_fulfillment_execution()'::regprocedure
  ) INTO current_definition;

  line_start := strpos(
    current_definition,
    E'  SELECT count(*) INTO line_mismatch_count\n'
  );
  line_end := strpos(
    current_definition,
    E'  SELECT count(*) INTO package_mismatch_count\n'
  );

  IF line_start = 0 OR line_end = 0 OR line_end <= line_start THEN
    RAISE EXCEPTION
      'Expected malformed fulfillment line comparison was not found';
  END IF;

  IF strpos(
       substr(current_definition, line_start + 1),
       E'  SELECT count(*) INTO line_mismatch_count\n'
     ) <> 0
  THEN
    RAISE EXCEPTION
      'Fulfillment line comparison marker is ambiguous';
  END IF;

  current_line_comparison := substr(
    current_definition,
    line_start,
    line_end - line_start
  );

  IF current_line_comparison = line_repair THEN
    revised_definition := current_definition;
  ELSIF length(current_line_comparison) = 3025
        AND md5(current_line_comparison)
          = '726cd3ef3667f7ffb812cdbd5ebca5c4'
  THEN
    revised_definition :=
      left(current_definition, line_start - 1)
      || line_repair
      || substr(current_definition, line_end);
  ELSE
    RAISE EXCEPTION
      'Unexpected fulfillment line comparison state; refusing to overwrite function drift';
  END IF;

  package_start := strpos(
    revised_definition,
    E'  SELECT count(*) INTO package_mismatch_count\n'
  );
  package_end := strpos(
    revised_definition,
    E'  SELECT count(*) INTO allocation_mismatch_count\n'
  );

  IF package_start = 0 OR package_end = 0 OR package_end <= package_start THEN
    RAISE EXCEPTION
      'Expected malformed fulfillment package comparison was not found';
  END IF;

  IF strpos(
       substr(revised_definition, package_start + 1),
       E'  SELECT count(*) INTO package_mismatch_count\n'
     ) <> 0
  THEN
    RAISE EXCEPTION
      'Fulfillment package comparison marker is ambiguous';
  END IF;

  current_package_comparison := substr(
    revised_definition,
    package_start,
    package_end - package_start
  );

  IF current_package_comparison = package_repair THEN
    NULL;
  ELSIF length(current_package_comparison) = 4356
        AND md5(current_package_comparison)
          = 'f8e5abb38a0c1f056fa8aa4a7cf5ffbb'
  THEN
    revised_definition :=
      left(revised_definition, package_start - 1)
      || package_repair
      || substr(revised_definition, package_end);
  ELSE
    RAISE EXCEPTION
      'Unexpected fulfillment package comparison state; refusing to overwrite function drift';
  END IF;

  IF revised_definition NOT LIKE '%canonical_line_mismatch%'
     OR revised_definition NOT LIKE '%execution_line_mismatch%'
     OR revised_definition NOT LIKE '%canonical_package_mismatch%'
     OR revised_definition NOT LIKE '%execution_package_mismatch%'
     OR revised_definition LIKE
       E'%SELECT count(*) INTO line_mismatch_count\n  FROM (\n    (\n%'
     OR revised_definition LIKE
       E'%SELECT count(*) INTO package_mismatch_count\n  FROM (\n    (\n%'
  THEN
    RAISE EXCEPTION
      'Fulfillment comparison arity repair was incomplete';
  END IF;

  EXECUTE revised_definition;
END;
$migration$;

COMMENT ON FUNCTION validate_operations_fulfillment_execution() IS
  'Validates immutable fulfillment lineage. Carrier evidence must match the complete fulfillment-address fingerprint, each normalized selected rate must equal one retained provider rate plus the exact package-plan hash and package count, and canonical/run versus execution-edge line and package comparisons are evaluated independently with compatible shapes.';
