-- Keep the fixed credential diagnostic separate from package-specific rates
-- requested for a cartonization plan. Both remain append-only sandbox evidence.

ALTER TABLE operations_carrier_rate_requests
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_purpose_check;

ALTER TABLE operations_carrier_rate_requests
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_purpose_valid;

ALTER TABLE operations_carrier_rate_requests
  ADD CONSTRAINT operations_carrier_rate_requests_purpose_valid
  CHECK (
    purpose IN (
      'sandbox_rate_test',
      'cartonization_package_rate'
    )
  );

COMMENT ON COLUMN operations_carrier_rate_requests.purpose IS
  'sandbox_rate_test is the fixed credential diagnostic eligible for test-label creation; cartonization_package_rate records a caller-supplied package used only for rate comparison.';
