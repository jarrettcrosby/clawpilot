-- Validate the populated dispatch-attempt table in its own transaction so the
-- lower-impact validation lock is released before other tables are scanned.
ALTER TABLE operations_active_carrier_group_attempts
  VALIDATE CONSTRAINT operations_active_carrier_attempt_safety_valid;
