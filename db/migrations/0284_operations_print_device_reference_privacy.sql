-- Remove legacy raw local-network printer endpoints from hosted print-delivery
-- evidence. The append-only guard is disabled only for this bounded column
-- remediation and is attested enabled before this migration can commit.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION
  normalize_operations_print_delivery_device_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.device_job_reference IS NOT NULL
     AND NOT (
       NEW.device_job_reference ~
         '^local-device[.]v1[.][A-Za-z0-9_-]{43}$'
       OR NEW.device_job_reference = 'local-device.legacy.v1.redacted'
     ) THEN
    NEW.device_job_reference := 'local-device.legacy.v1.redacted';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  normalize_operations_print_delivery_device_reference_write
  ON operations_print_delivery_attempts;
CREATE TRIGGER normalize_operations_print_delivery_device_reference_write
BEFORE INSERT ON operations_print_delivery_attempts
FOR EACH ROW EXECUTE FUNCTION
  normalize_operations_print_delivery_device_reference();

COMMENT ON FUNCTION
  normalize_operations_print_delivery_device_reference() IS
  'Prevents old local print-agent writers from persisting raw LAN printer endpoints during and after rolling application deployment.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid =
      to_regclass('operations_print_delivery_attempts')
      AND trigger_row.tgname =
        'protect_operations_print_delivery_attempt_write'
      AND trigger_row.tgfoid =
        to_regprocedure('protect_operations_append_only()')
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 27
  ) THEN
    RAISE EXCEPTION
      'operations print-delivery append-only guard must be enabled before privacy remediation';
  END IF;
END;
$$;

ALTER TABLE operations_print_delivery_attempts
  DISABLE TRIGGER protect_operations_print_delivery_attempt_write;

UPDATE operations_print_delivery_attempts
SET device_job_reference = 'local-device.legacy.v1.redacted'
WHERE device_job_reference IS NOT NULL
  AND NOT (
    device_job_reference ~
      '^local-device[.]v1[.][A-Za-z0-9_-]{43}$'
    OR device_job_reference = 'local-device.legacy.v1.redacted'
  );

ALTER TABLE operations_print_delivery_attempts
  ENABLE TRIGGER protect_operations_print_delivery_attempt_write;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM operations_print_delivery_attempts
    WHERE device_job_reference IS NOT NULL
      AND NOT (
        device_job_reference ~
          '^local-device[.]v1[.][A-Za-z0-9_-]{43}$'
        OR device_job_reference = 'local-device.legacy.v1.redacted'
      )
  ) THEN
    RAISE EXCEPTION
      'legacy raw local printer references remain after privacy remediation';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid =
      to_regclass('operations_print_delivery_attempts')
      AND trigger_row.tgname =
        'protect_operations_print_delivery_attempt_write'
      AND trigger_row.tgfoid =
        to_regprocedure('protect_operations_append_only()')
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 27
  ) THEN
    RAISE EXCEPTION
      'operations print-delivery append-only guard was not restored';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid =
      to_regclass('operations_print_delivery_attempts')
      AND trigger_row.tgname =
        'normalize_operations_print_delivery_device_reference_write'
      AND trigger_row.tgfoid = to_regprocedure(
        'normalize_operations_print_delivery_device_reference()'
      )
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 7
  ) THEN
    RAISE EXCEPTION
      'operations print-delivery device-reference normalization guard is unavailable';
  END IF;
END;
$$;
