-- Fulfillment rerating intentionally removes ClawPilot-only package keys
-- before calling UPS or FedEx. The deferred execution validator must compare
-- retained carrier evidence with that exact provider request shape, while the
-- separate package and allocation invariants continue to prove the canonical
-- package identity.

DO $migration$
DECLARE
  current_definition text;
  revised_definition text;
  parcel_start integer;
  parcel_end integer;
  provider_parcel_start integer;
  current_parcel_comparison text;
  provider_parcel_repair constant text := $parcel$  SELECT jsonb_agg(
    operations_shopify_checkout_carrier_request_parcel_snapshot(
      'approved_recipe',
      package.package_sequence,
      package.length_mm,
      package.width_mm,
      package.height_mm,
      package.gross_weight_grams
    )
    ORDER BY package.package_sequence, package.package_key
  )
  INTO ordered_fulfillment_parcels
  FROM operations_pack_rate_run_packages package
  WHERE package.organization_id = execution.organization_id
    AND package.run_id = execution.fulfillment_pack_rate_run_id;

$parcel$;
BEGIN
  SELECT pg_get_functiondef(
    'validate_operations_fulfillment_execution()'::regprocedure
  ) INTO current_definition;

  parcel_start := strpos(
    current_definition,
    E'  SELECT jsonb_agg(\n'
      || E'    operations_shopify_checkout_carrier_parcel_snapshot(\n'
  );
  IF parcel_start <> 0 THEN
    parcel_end := strpos(
      substr(current_definition, parcel_start),
      E'  IF run.provider = ''shopify'' THEN\n'
    );
    IF parcel_end <> 0 THEN
      parcel_end := parcel_start + parcel_end - 1;
    END IF;
  END IF;

  IF parcel_start = 0
     OR COALESCE(parcel_end, 0) = 0
     OR parcel_end <= parcel_start
  THEN
    provider_parcel_start := strpos(
      current_definition,
      provider_parcel_repair
    );
    IF provider_parcel_start <> 0
       AND strpos(
         substr(current_definition, provider_parcel_start + 1),
         provider_parcel_repair
       ) = 0
    THEN
      revised_definition := current_definition;
    ELSE
      RAISE EXCEPTION
        'Expected fulfillment carrier parcel comparison was not found';
    END IF;
  ELSE
    IF strpos(
         substr(current_definition, parcel_start + 1),
         E'  SELECT jsonb_agg(\n'
           || E'    operations_shopify_checkout_carrier_parcel_snapshot(\n'
       ) <> 0
    THEN
      RAISE EXCEPTION
        'Fulfillment carrier parcel comparison marker is ambiguous';
    END IF;

    current_parcel_comparison := substr(
      current_definition,
      parcel_start,
      parcel_end - parcel_start
    );

    IF length(current_parcel_comparison) = 522
       AND md5(current_parcel_comparison)
         = 'd4b3fc3616b0e31c9d12c02ce8d0170b'
    THEN
      revised_definition :=
        left(current_definition, parcel_start - 1)
        || provider_parcel_repair
        || substr(current_definition, parcel_end);
    ELSE
      RAISE EXCEPTION
        'Unexpected fulfillment carrier parcel comparison state; refusing to overwrite function drift';
    END IF;
  END IF;

  IF strpos(revised_definition, provider_parcel_repair) = 0
     OR revised_definition LIKE
       E'%operations_shopify_checkout_carrier_parcel_snapshot(\n'
       || E'      package.package_key,%'
  THEN
    RAISE EXCEPTION
      'Fulfillment carrier parcel evidence repair was incomplete';
  END IF;

  EXECUTE revised_definition;
END;
$migration$;

COMMENT ON FUNCTION validate_operations_fulfillment_execution() IS
  'Validates immutable fulfillment lineage. Carrier evidence must match the complete fulfillment-address fingerprint and exact provider request parcel shape; each normalized selected rate must equal one retained provider rate plus the exact package-plan hash and package count; canonical/run versus execution-edge line and package comparisons remain independent compatible-shape symmetric differences.';
