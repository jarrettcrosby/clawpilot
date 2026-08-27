-- Bind every checkout package method to the immutable cartonization authority
-- retained on the allocated receipt line. This prevents a unit-material line
-- from being finalized as an approved Product-pack carton, or vice versa.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION
  validate_operations_shopify_checkout_unit_material_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_planning_method text;
  target_cartonization_authority text;
  retained_allocation_count bigint;
BEGIN
  SELECT
    package.planning_method,
    CASE
      WHEN line.line_snapshot ->> 'snapshotVersion'
        = 'shopify-checkout-line-pack-evidence-v2'
        THEN line.line_snapshot ->> 'cartonizationAuthority'
      WHEN line.line_snapshot ->> 'snapshotVersion'
        = 'shopify-checkout-line-pack-evidence-v1'
        THEN 'product_pack'
      ELSE NULL
    END
  INTO target_planning_method, target_cartonization_authority
  FROM operations_shopify_checkout_rate_receipt_packages package
  JOIN operations_shopify_checkout_rate_receipt_lines line
    ON line.organization_id = package.organization_id
   AND line.receipt_id = package.receipt_id
   AND line.line_key = NEW.line_key
  WHERE package.organization_id = NEW.organization_id
    AND package.receipt_id = NEW.receipt_id
    AND package.package_key = NEW.package_key
  FOR UPDATE OF package, line;

  IF target_planning_method IS NULL
     OR target_cartonization_authority IS NULL
     OR target_cartonization_authority NOT IN (
       'product_pack', 'unit_material_selection'
     ) THEN
    RAISE EXCEPTION
      'Shopify checkout allocation lacks valid retained line authority';
  END IF;

  IF (target_planning_method = 'unit_material_selection') <>
     (target_cartonization_authority = 'unit_material_selection') THEN
    RAISE EXCEPTION
      'Shopify checkout package method conflicts with retained line authority';
  END IF;

  IF target_planning_method <> 'unit_material_selection' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO retained_allocation_count
  FROM operations_shopify_checkout_rate_receipt_allocations allocation
  WHERE allocation.organization_id = NEW.organization_id
    AND allocation.receipt_id = NEW.receipt_id
    AND allocation.package_key = NEW.package_key;
  IF NEW.quantity <> 1 OR retained_allocation_count <> 0 THEN
    RAISE EXCEPTION
      'Each Shopify checkout unit-material package must allocate exactly one line unit';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        package.planning_method,
        CASE
          WHEN line.line_snapshot ->> 'snapshotVersion'
            = 'shopify-checkout-line-pack-evidence-v2'
            THEN line.line_snapshot ->> 'cartonizationAuthority'
          WHEN line.line_snapshot ->> 'snapshotVersion'
            = 'shopify-checkout-line-pack-evidence-v1'
            THEN 'product_pack'
          ELSE NULL
        END AS cartonization_authority
      FROM operations_shopify_checkout_rate_receipt_allocations allocation
      JOIN operations_shopify_checkout_rate_receipt_packages package
        ON package.organization_id = allocation.organization_id
       AND package.receipt_id = allocation.receipt_id
       AND package.package_key = allocation.package_key
      JOIN operations_shopify_checkout_rate_receipt_lines line
        ON line.organization_id = allocation.organization_id
       AND line.receipt_id = allocation.receipt_id
       AND line.line_key = allocation.line_key
    ) retained
    WHERE retained.cartonization_authority IS NULL
       OR (
         (retained.planning_method = 'unit_material_selection') <>
         (retained.cartonization_authority = 'unit_material_selection')
       )
  ) THEN
    RAISE EXCEPTION
      'Existing Shopify checkout allocation conflicts with retained line authority';
  END IF;
END;
$$;

COMMENT ON FUNCTION
  validate_operations_shopify_checkout_unit_material_allocation() IS
  'Binds each package planning method to the allocated receipt-line cartonization authority and preserves one-unit package cardinality.';
