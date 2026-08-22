-- UPS CIE returns one documented masked tracking value for TEST labels. The
-- original validator admitted that value only for native one-off groups, but
-- canonical Shopify test-store E2E labels use the standard package-label
-- command. Admit the sentinel only when the inserted label is bound to its
-- exact prepared standard sandbox attempt; production and unbound labels stay
-- fail closed.
CREATE OR REPLACE FUNCTION validate_operations_one_off_group_label()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  label_order_id uuid;
  label_plan_id uuid;
  label_is_one_off boolean;
BEGIN
  SELECT plan.order_id, plan.id, plan.one_off_quote_id IS NOT NULL
    INTO label_order_id, label_plan_id, label_is_one_off
  FROM operations_packages package
  JOIN operations_fulfillment_plans plan
    ON plan.organization_id = package.organization_id
   AND plan.id = package.plan_id
  WHERE package.organization_id = NEW.organization_id
    AND package.id = NEW.package_id;
  IF label_is_one_off THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'operations:one-off-carrier-group:' || NEW.organization_id::text
        || ':' || label_order_id::text,
      0
    ));
    IF EXISTS (
      SELECT 1
      FROM operations_one_off_carrier_group_attempts active_group
      WHERE active_group.organization_id = NEW.organization_id
        AND active_group.order_id = label_order_id
        AND active_group.plan_id = label_plan_id
        AND active_group.action = 'create'
        AND (
          active_group.state IN ('prepared', 'unknown')
          OR (
            active_group.state = 'succeeded'
            AND NOT EXISTS (
              SELECT 1
              FROM operations_one_off_carrier_group_attempts closed
              WHERE closed.organization_id = active_group.organization_id
                AND closed.create_attempt_id = active_group.id
                AND closed.action IN ('void', 'close_sample')
                AND closed.state = 'succeeded'
            )
          )
        )
        AND NEW.one_off_carrier_group_attempt_id IS DISTINCT FROM active_group.id
    ) THEN
      RAISE EXCEPTION
        'A native one-off package cannot mix label lineage with an active carrier group';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.one_off_carrier_group_attempt_id
      IS DISTINCT FROM OLD.one_off_carrier_group_attempt_id THEN
    RAISE EXCEPTION 'One-off label group lineage is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.one_off_void_group_attempt_id IS NOT NULL
     AND NEW.one_off_void_group_attempt_id
       IS DISTINCT FROM OLD.one_off_void_group_attempt_id THEN
    RAISE EXCEPTION 'One-off label void-group lineage is immutable';
  END IF;
  IF NEW.environment = 'sandbox'
     AND lower(NEW.carrier) IN ('ups', 'ups_rest')
     AND NEW.tracking_number ~* '^1Z[X]{16}$'
     AND NOT (
       (
         NEW.one_off_carrier_group_attempt_id IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM operations_one_off_carrier_group_attempts masked_attempt
           WHERE masked_attempt.organization_id = NEW.organization_id
             AND masked_attempt.id = NEW.one_off_carrier_group_attempt_id
             AND masked_attempt.action = 'create'
             AND masked_attempt.environment = 'sandbox'
             AND masked_attempt.provider = 'ups_rest'
         )
       )
       OR (
         NEW.one_off_carrier_group_attempt_id IS NULL
         AND NEW.create_attempt_id IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM operations_label_attempts masked_standard_attempt
           JOIN operations_packages masked_package
             ON masked_package.organization_id = masked_standard_attempt.organization_id
            AND masked_package.id = masked_standard_attempt.package_id
           JOIN operations_fulfillment_plans masked_plan
             ON masked_plan.organization_id = masked_package.organization_id
            AND masked_plan.id = masked_package.plan_id
           WHERE masked_standard_attempt.organization_id = NEW.organization_id
             AND masked_standard_attempt.id = NEW.create_attempt_id
             AND masked_standard_attempt.package_id = NEW.package_id
             AND masked_standard_attempt.carrier_rate_id = NEW.carrier_rate_id
             AND masked_standard_attempt.integration_account_id =
               NEW.integration_account_id
             AND masked_standard_attempt.carrier_account_id =
               NEW.carrier_account_id
             AND masked_standard_attempt.action = 'create'
             AND masked_standard_attempt.state = 'prepared'
             AND masked_standard_attempt.environment = 'sandbox'
             AND masked_standard_attempt.provider = 'ups_rest'
             AND masked_plan.one_off_quote_id IS NULL
         )
       )
     ) THEN
    RAISE EXCEPTION
      'UPS CIE masked tracking requires an exact sandbox one-off group or standard label attempt';
  END IF;
  IF NEW.one_off_carrier_group_attempt_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM operations_one_off_carrier_group_attempts attempt
    JOIN operations_one_off_carrier_group_members member
      ON member.organization_id = attempt.organization_id
     AND member.carrier_group_attempt_id = attempt.id
     AND member.package_id = NEW.package_id
    WHERE attempt.organization_id = NEW.organization_id
      AND attempt.id = NEW.one_off_carrier_group_attempt_id
      AND attempt.action = 'create'
      AND attempt.carrier_rate_id = NEW.carrier_rate_id
      AND attempt.integration_account_id = NEW.integration_account_id
      AND attempt.carrier_account_id = NEW.carrier_account_id
      AND attempt.environment = NEW.environment
      AND NEW.carrier = CASE attempt.provider
        WHEN 'ups_rest' THEN 'UPS'
        WHEN 'fedex_rest' THEN 'FedEx'
      END
      AND NEW.service_code = attempt.service_code
  ) THEN
    RAISE EXCEPTION 'One-off label must belong to its exact prepared group member';
  END IF;
  IF NEW.one_off_void_group_attempt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM operations_one_off_carrier_group_attempts void_attempt
    WHERE void_attempt.organization_id = NEW.organization_id
      AND void_attempt.id = NEW.one_off_void_group_attempt_id
      AND void_attempt.action IN ('void', 'close_sample')
      AND void_attempt.create_attempt_id = NEW.one_off_carrier_group_attempt_id
  ) THEN
    RAISE EXCEPTION 'One-off label void must reference its exact whole-shipment group';
  END IF;
  IF (
    NEW.status = 'created' AND NEW.one_off_void_group_attempt_id IS NOT NULL
  ) OR (
    NEW.status = 'voided' AND NEW.one_off_void_group_attempt_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'One-off label status and whole-shipment void lineage must transition together';
  END IF;
  RETURN NEW;
END;
$$;

-- Both pre-fix standard TEST calls reached UPS and received only the documented
-- masked response, but Postgres rejected their label rows through the validator
-- above. No provider-native payload survived the rolled-back transaction, so
-- only this exact masked standard-attempt shape can be retired for one new call.
DROP TRIGGER IF EXISTS protect_operations_label_attempt_write
  ON operations_label_attempts;

UPDATE operations_label_attempts AS attempt
SET state = 'failed',
    error_code = 'OPERATIONS_SANDBOX_MASKED_TRACKING_RETRYABLE',
    redacted_response = attempt.redacted_response || jsonb_build_object(
      'persistenceDisposition', 'sandbox_masked_tracking_rejected',
      'retryAuthorizedByMigration',
      '0320_operations_standard_sandbox_masked_tracking'
    )
FROM operations_packages package
JOIN operations_fulfillment_plans plan
  ON plan.organization_id = package.organization_id
 AND plan.id = package.plan_id
WHERE attempt.organization_id = package.organization_id
  AND attempt.package_id = package.id
  AND attempt.state = 'unknown'
  AND attempt.action = 'create'
  AND attempt.environment = 'sandbox'
  AND attempt.provider = 'ups_rest'
  AND attempt.error_code = 'OPERATIONS_LABEL_PERSISTENCE_UNKNOWN'
  AND attempt.redacted_response ->> 'trackingNumber' ~* '^1Z[X]{16}$'
  AND plan.one_off_quote_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM operations_labels AS package_label
    WHERE package_label.organization_id = attempt.organization_id
      AND package_label.package_id = attempt.package_id
      AND package_label.status = 'created'
  );

CREATE TRIGGER protect_operations_label_attempt_write
BEFORE UPDATE OR DELETE ON operations_label_attempts
FOR EACH ROW EXECUTE FUNCTION protect_operations_label_attempt();
