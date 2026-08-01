-- Shopify checkout callbacks intentionally retain only a postal/country
-- carrier destination identity. Shadow fulfillment later rates the canonical
-- order's complete ship-to address, so its carrier evidence must be bound to
-- the separate full-address fingerprint persisted on the fulfillment run.

DO $migration$
DECLARE
  current_definition text;
  revised_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'validate_operations_fulfillment_execution()'::regprocedure
  ) INTO current_definition;

  revised_definition := replace(
    current_definition,
    'max(receipt.carrier_destination_fingerprint)',
    'max(run.input_snapshot->>''carrierDestinationFingerprint'')'
  );

  IF revised_definition = current_definition THEN
    RAISE EXCEPTION
      'Expected Shopify checkout destination fingerprint selector was not found';
  END IF;

  IF revised_definition LIKE '%max(receipt.carrier_destination_fingerprint)%'
  THEN
    RAISE EXCEPTION
      'Shopify fulfillment destination fingerprint repair was incomplete';
  END IF;

  EXECUTE revised_definition;
END;
$migration$;

COMMENT ON FUNCTION validate_operations_fulfillment_execution() IS
  'Validates immutable fulfillment lineage. Shopify checkout retains its sparse postal/country destination identity, while carrier rerate attempts must match the separate complete fulfillment-address fingerprint stored on the fulfillment run.';
