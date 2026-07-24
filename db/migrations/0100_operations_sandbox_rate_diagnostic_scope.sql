-- Sandbox credential diagnostics are account-scoped but do not involve a
-- reseller network authorization. Delegated quote and label workflows retain
-- their authorization requirements on their transactional records.
ALTER TABLE operations_carrier_rate_requests
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_authorization_scope_valid;

ALTER TABLE operations_carrier_rate_requests
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_authorization_scope_consistent;

ALTER TABLE operations_carrier_rate_requests
  ADD CONSTRAINT operations_carrier_rate_requests_authorization_scope_consistent
  CHECK (
    (
      network_id IS NULL
      AND account_authorization_id IS NULL
    )
    OR (
      network_id IS NOT NULL
      AND account_authorization_id IS NOT NULL
    )
  );

COMMENT ON CONSTRAINT operations_carrier_rate_requests_authorization_scope_consistent
  ON operations_carrier_rate_requests IS
  'Standalone provider sandbox diagnostics omit network authorization; delegated rate requests must record both network and authorization.';
