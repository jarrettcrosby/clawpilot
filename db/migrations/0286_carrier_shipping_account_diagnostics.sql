-- Shipping Settings can exercise one exact UPS/FedEx account in its provider
-- sandbox or, behind the separately authorized live-postage gate, production.
-- Existing sandbox diagnostic rows retain their identity and behavior.

ALTER TABLE operations_carrier_rate_requests
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_purpose_check,
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_purpose_valid,
  ADD CONSTRAINT operations_carrier_rate_requests_purpose_valid CHECK (
    purpose IN (
      'sandbox_rate_test',
      'shipping_account_diagnostic',
      'cartonization_package_rate',
      'cartonization_shipment_rate',
      'one_off_transport_rate'
    )
  );

ALTER TABLE operations_carrier_rate_test_labels
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_test_labels_environment_check,
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_test_labels_environment_valid,
  ADD CONSTRAINT operations_carrier_rate_test_labels_environment_valid CHECK (
    environment IN ('sandbox', 'production')
  );

ALTER TABLE operations_carrier_rate_test_label_attempts
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_test_label_attempts_environment_check,
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_test_label_attempts_environment_valid,
  ADD CONSTRAINT operations_carrier_rate_test_label_attempts_environment_valid CHECK (
    environment IN ('sandbox', 'production')
  );

-- Health reads only the newest bounded window; keep that lookup index-only so
-- a long-lived diagnostic history never turns readiness into an unbounded scan.
CREATE INDEX IF NOT EXISTS
  operations_carrier_rate_test_attempts_health_recent_idx
ON operations_carrier_rate_test_label_attempts (
  requested_at DESC, id DESC
)
INCLUDE (environment, state);

-- A fresh quote or idempotency key must not bypass an unresolved LIVE Ship.
-- The account-wide fence is intentionally conservative: another account may
-- proceed, but this exact production billing account cannot buy more postage
-- until the prepared/unknown attempt reaches an evidenced terminal outcome.
CREATE UNIQUE INDEX IF NOT EXISTS
  operations_carrier_test_attempts_live_account_open_unique
ON operations_carrier_rate_test_label_attempts (
  organization_id, carrier_account_id
)
WHERE environment = 'production'
  AND action = 'create'
  AND state IN ('prepared', 'unknown');

-- A successfully created diagnostic remains the one active LIVE label on the
-- exact account until its true provider void completes.
CREATE UNIQUE INDEX IF NOT EXISTS
  operations_carrier_test_labels_live_account_active_unique
ON operations_carrier_rate_test_labels (
  organization_id, carrier_account_id
)
WHERE environment = 'production' AND status = 'created';

-- Prepared LIVE Ship calls hold a small durable lease counter directly on
-- every authority row whose mutation could invalidate the provider call.
-- Counters support simultaneous diagnostics on different carrier accounts.
ALTER TABLE operations_activation_scopes
  ADD COLUMN IF NOT EXISTS
    production_shipping_diagnostic_lease_count integer NOT NULL DEFAULT 0,
  DROP CONSTRAINT IF EXISTS
    operations_activation_scopes_shipping_diagnostic_lease_valid,
  ADD CONSTRAINT
    operations_activation_scopes_shipping_diagnostic_lease_valid
    CHECK (production_shipping_diagnostic_lease_count >= 0);

ALTER TABLE operations_integration_accounts
  ADD COLUMN IF NOT EXISTS
    production_shipping_diagnostic_lease_count integer NOT NULL DEFAULT 0,
  DROP CONSTRAINT IF EXISTS
    operations_integration_accounts_shipping_diagnostic_lease_valid,
  ADD CONSTRAINT
    operations_integration_accounts_shipping_diagnostic_lease_valid
    CHECK (production_shipping_diagnostic_lease_count >= 0);

ALTER TABLE operations_carrier_credentials
  ADD COLUMN IF NOT EXISTS
    production_shipping_diagnostic_lease_count integer NOT NULL DEFAULT 0,
  DROP CONSTRAINT IF EXISTS
    operations_carrier_credentials_shipping_diagnostic_lease_valid,
  ADD CONSTRAINT
    operations_carrier_credentials_shipping_diagnostic_lease_valid
    CHECK (production_shipping_diagnostic_lease_count >= 0);

ALTER TABLE operations_carrier_accounts
  ADD COLUMN IF NOT EXISTS
    production_shipping_diagnostic_lease_count integer NOT NULL DEFAULT 0,
  DROP CONSTRAINT IF EXISTS
    operations_carrier_accounts_shipping_diagnostic_lease_valid,
  ADD CONSTRAINT
    operations_carrier_accounts_shipping_diagnostic_lease_valid
    CHECK (production_shipping_diagnostic_lease_count >= 0);

-- A diagnostic label/attempt must retain the exact environment, provider,
-- integration account, carrier account, credential generation, and rate hash
-- of the immutable rate evidence that authorized it.
CREATE OR REPLACE FUNCTION validate_operations_carrier_shipping_diagnostic_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence operations_carrier_rate_requests%ROWTYPE;
  production_create_authorized boolean;
  production_void_authorized boolean;
  sandbox_void_authorized boolean;
  diagnostic_row jsonb;
BEGIN
  diagnostic_row := to_jsonb(NEW);
  SELECT * INTO evidence
  FROM operations_carrier_rate_requests rate
  WHERE rate.organization_id = NEW.organization_id
    AND rate.id = NEW.rate_request_id;

  IF NOT FOUND
     OR evidence.status <> 'succeeded'
     OR evidence.provider NOT IN ('ups_rest', 'fedex_rest')
     OR evidence.purpose NOT IN (
       'sandbox_rate_test',
       'shipping_account_diagnostic'
     )
     OR evidence.provider <> NEW.provider
     OR evidence.environment <> NEW.environment
     OR evidence.integration_account_id <> NEW.integration_account_id
     OR evidence.carrier_account_id <> NEW.carrier_account_id
     OR (
       evidence.purpose = 'sandbox_rate_test'
       AND evidence.environment <> 'sandbox'
     )
     OR (
       evidence.purpose = 'shipping_account_diagnostic'
       AND evidence.environment <> 'production'
     )
     OR (
       evidence.credential_version <> NEW.credential_version
       AND NOT (
         TG_TABLE_NAME = 'operations_carrier_rate_test_label_attempts'
         AND diagnostic_row->>'action' = 'void'
         AND NEW.environment IN ('sandbox', 'production')
       )
     )
  THEN
    RAISE EXCEPTION
      'Carrier shipping diagnostic must bind exact successful rate evidence';
  END IF;

  IF TG_TABLE_NAME = 'operations_carrier_rate_test_labels'
     AND evidence.request_hash <>
       diagnostic_row->>'rate_request_hash'
  THEN
    RAISE EXCEPTION
      'Carrier shipping diagnostic label must retain the exact rate request hash';
  END IF;

  IF TG_TABLE_NAME = 'operations_carrier_rate_test_label_attempts'
     AND diagnostic_row->>'action' = 'create'
     AND NEW.environment = 'production'
  THEN
    PERFORM 1
      FROM operations_integration_accounts integration
      JOIN operations_carrier_credentials credential
        ON credential.organization_id = integration.organization_id
       AND credential.integration_account_id = integration.id
      JOIN operations_carrier_accounts carrier_account
        ON carrier_account.organization_id = integration.organization_id
       AND carrier_account.integration_account_id = integration.id
      JOIN operations_activation_scopes activation
        ON activation.organization_id = integration.organization_id
      WHERE integration.organization_id = NEW.organization_id
        AND integration.id = NEW.integration_account_id
        AND integration.provider = NEW.provider
        AND integration.environment = 'production'
        AND integration.status = 'active'
        AND integration.configuration->'allowedCapabilities'
          ? 'production_rate'
        AND integration.configuration->'allowedCapabilities'
          ? 'production_label'
        AND credential.credential_version = NEW.credential_version
        AND credential.verification_status = 'verified'
        AND evidence.billing_selection_snapshot->>'credentialFingerprint'
          = credential.credential_fingerprint
        AND carrier_account.id = NEW.carrier_account_id
        AND carrier_account.status = 'active'
        AND carrier_account.allow_sender_billing = true
        AND evidence.billing_selection_snapshot->>'accountNumberFingerprint'
          = carrier_account.account_number_fingerprint
        AND evidence.billing_selection_snapshot->>'registeredAddressFingerprint'
          = carrier_account.registered_address_fingerprint
        AND evidence.billing_selection_snapshot->>'senderName'
          = carrier_account.sender_name
        AND activation.state = 'active'
      FOR UPDATE OF integration, credential, carrier_account, activation
    ;
    production_create_authorized := FOUND;

    IF NOT production_create_authorized THEN
      RAISE EXCEPTION
        'LIVE carrier shipping diagnostic create requires current Active production-label authority';
    END IF;
  END IF;

  -- Sandbox labels must remain voidable after a verified credential rotation.
  -- The immutable label and rate evidence still bind the original provider,
  -- environment, integration, carrier account, account-number fingerprint,
  -- and shipment. Only the credential generation may advance, and it must be
  -- the currently verified credential for that exact sandbox integration.
  IF TG_TABLE_NAME = 'operations_carrier_rate_test_label_attempts'
     AND diagnostic_row->>'action' = 'void'
     AND NEW.environment = 'sandbox'
  THEN
    SELECT EXISTS (
      SELECT 1
      FROM operations_carrier_rate_test_labels label
      JOIN operations_integration_accounts integration
        ON integration.organization_id = label.organization_id
       AND integration.id = label.integration_account_id
      JOIN operations_carrier_credentials credential
        ON credential.organization_id = integration.organization_id
       AND credential.integration_account_id = integration.id
      JOIN operations_carrier_accounts carrier_account
        ON carrier_account.organization_id = integration.organization_id
       AND carrier_account.integration_account_id = integration.id
       AND carrier_account.id = label.carrier_account_id
      WHERE label.organization_id = NEW.organization_id
        AND label.id = NEW.label_id
        AND label.rate_request_id = NEW.rate_request_id
        AND label.integration_account_id = NEW.integration_account_id
        AND label.carrier_account_id = NEW.carrier_account_id
        AND label.provider = NEW.provider
        AND label.environment = 'sandbox'
        AND label.status = 'created'
        AND label.account_number_fingerprint =
          carrier_account.account_number_fingerprint
        AND integration.provider = NEW.provider
        AND integration.environment = 'sandbox'
        AND integration.status = 'active'
        AND credential.credential_version = NEW.credential_version
        AND credential.verification_status = 'verified'
        AND carrier_account.status = 'active'
        AND carrier_account.allow_sender_billing = true
    ) INTO sandbox_void_authorized;

    IF NOT sandbox_void_authorized THEN
      RAISE EXCEPTION
        'Sandbox carrier shipping diagnostic void requires the current exact credential and original sender account';
    END IF;
  END IF;

  -- A paid production label must remain voidable after Operations Active or
  -- the purchase capability is revoked. Credential rotation is also allowed:
  -- the void attempt stores and verifies the current credential generation,
  -- while the immutable label continues to retain the original generation.
  IF TG_TABLE_NAME = 'operations_carrier_rate_test_label_attempts'
     AND diagnostic_row->>'action' = 'void'
     AND NEW.environment = 'production'
  THEN
    SELECT EXISTS (
      SELECT 1
      FROM operations_integration_accounts integration
      JOIN operations_carrier_credentials credential
        ON credential.organization_id = integration.organization_id
       AND credential.integration_account_id = integration.id
      JOIN operations_carrier_accounts carrier_account
        ON carrier_account.organization_id = integration.organization_id
       AND carrier_account.integration_account_id = integration.id
      WHERE integration.organization_id = NEW.organization_id
        AND integration.id = NEW.integration_account_id
        AND integration.provider = NEW.provider
        AND integration.environment = 'production'
        AND integration.status = 'active'
        AND credential.credential_version = NEW.credential_version
        AND credential.verification_status = 'verified'
        AND carrier_account.id = NEW.carrier_account_id
        AND carrier_account.status = 'active'
        AND carrier_account.allow_sender_billing = true
    ) INTO production_void_authorized;

    IF NOT production_void_authorized THEN
      RAISE EXCEPTION
        'LIVE carrier shipping diagnostic void requires the current exact production credential and sender account';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  maintain_operations_carrier_shipping_diagnostic_authority_lease()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_row operations_carrier_rate_test_label_attempts%ROWTYPE;
  lease_delta integer := 0;
  prior_internal_flag text;
BEGIN
  attempt_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF attempt_row.environment <> 'production'
     OR attempt_row.action <> 'create'
  THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.state = 'prepared' THEN
    lease_delta := 1;
  ELSIF TG_OP = 'UPDATE'
        AND OLD.state = 'prepared'
        AND NEW.state <> 'prepared'
  THEN
    lease_delta := -1;
  ELSIF TG_OP = 'DELETE' AND OLD.state = 'prepared' THEN
    lease_delta := -1;
  ELSE
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  prior_internal_flag := current_setting(
    'clawpilot.carrier_shipping_diagnostic_lease_update', true
  );
  PERFORM set_config(
    'clawpilot.carrier_shipping_diagnostic_lease_update', '1', true
  );

  UPDATE operations_activation_scopes
  SET production_shipping_diagnostic_lease_count =
    production_shipping_diagnostic_lease_count + lease_delta
  WHERE organization_id = attempt_row.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'LIVE carrier diagnostic authority lease requires Operations activation';
  END IF;

  UPDATE operations_integration_accounts
  SET production_shipping_diagnostic_lease_count =
    production_shipping_diagnostic_lease_count + lease_delta
  WHERE organization_id = attempt_row.organization_id
    AND id = attempt_row.integration_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'LIVE carrier diagnostic authority lease requires its integration';
  END IF;

  UPDATE operations_carrier_credentials
  SET production_shipping_diagnostic_lease_count =
    production_shipping_diagnostic_lease_count + lease_delta
  WHERE organization_id = attempt_row.organization_id
    AND integration_account_id = attempt_row.integration_account_id
    AND credential_version = attempt_row.credential_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'LIVE carrier diagnostic authority lease requires its credential';
  END IF;

  UPDATE operations_carrier_accounts
  SET production_shipping_diagnostic_lease_count =
    production_shipping_diagnostic_lease_count + lease_delta
  WHERE organization_id = attempt_row.organization_id
    AND integration_account_id = attempt_row.integration_account_id
    AND id = attempt_row.carrier_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'LIVE carrier diagnostic authority lease requires its sender account';
  END IF;

  PERFORM set_config(
    'clawpilot.carrier_shipping_diagnostic_lease_update',
    COALESCE(prior_internal_flag, ''),
    true
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- The production create transaction locks and increments every authority row
-- above. These update guards make that counter a true lease: an Active
-- downgrade, capability revoke, credential disable/rotation, or sender-account
-- disable waits for the insert and then fails while its provider outcome is
-- still prepared. If the authority update locked first, the insert waits and
-- then revalidates the new state before it can persist.
CREATE OR REPLACE FUNCTION
  protect_operations_carrier_shipping_diagnostic_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.production_shipping_diagnostic_lease_count IS DISTINCT FROM
       OLD.production_shipping_diagnostic_lease_count
     AND current_setting(
       'clawpilot.carrier_shipping_diagnostic_lease_update', true
     ) IS DISTINCT FROM '1'
  THEN
    RAISE EXCEPTION
      'LIVE carrier diagnostic authority lease counters are system-managed';
  END IF;

  IF TG_TABLE_NAME = 'operations_activation_scopes' THEN
    IF NEW.production_shipping_diagnostic_lease_count > 0
       AND NEW.state <> 'active'
    THEN
      RAISE EXCEPTION
        'Operations Active cannot be revoked during a prepared LIVE carrier diagnostic';
    END IF;
  ELSIF TG_TABLE_NAME = 'operations_integration_accounts' THEN
    IF NEW.production_shipping_diagnostic_lease_count > 0
       AND (
         NEW.status <> 'active'
         OR NEW.environment <> 'production'
         OR NEW.provider NOT IN ('ups_rest', 'fedex_rest')
         OR NOT (NEW.configuration->'allowedCapabilities'
           ? 'production_rate')
         OR NOT (NEW.configuration->'allowedCapabilities'
           ? 'production_label')
       )
    THEN
      RAISE EXCEPTION
        'LIVE carrier authority cannot be revoked during a prepared diagnostic';
    END IF;
  ELSIF TG_TABLE_NAME = 'operations_carrier_credentials' THEN
    IF NEW.production_shipping_diagnostic_lease_count > 0
       AND ROW(
         NEW.credential_ciphertext,
         NEW.credential_iv,
         NEW.credential_tag,
         NEW.credential_version,
         NEW.credential_fingerprint,
         NEW.verification_status
       ) IS DISTINCT FROM ROW(
         OLD.credential_ciphertext,
         OLD.credential_iv,
         OLD.credential_tag,
         OLD.credential_version,
         OLD.credential_fingerprint,
         OLD.verification_status
       )
    THEN
      RAISE EXCEPTION
        'LIVE carrier credential cannot change during a prepared diagnostic';
    END IF;
  ELSIF TG_TABLE_NAME = 'operations_carrier_accounts' THEN
    IF NEW.production_shipping_diagnostic_lease_count > 0
       AND ROW(
         NEW.integration_account_id,
         NEW.status,
         NEW.allow_sender_billing,
         NEW.account_number_ciphertext,
         NEW.account_number_iv,
         NEW.account_number_tag,
         NEW.encryption_version,
         NEW.account_number_last_four,
         NEW.account_number_fingerprint,
         NEW.registered_address,
         NEW.registered_address_fingerprint,
         NEW.sender_name
       ) IS DISTINCT FROM ROW(
         OLD.integration_account_id,
         OLD.status,
         OLD.allow_sender_billing,
         OLD.account_number_ciphertext,
         OLD.account_number_iv,
         OLD.account_number_tag,
         OLD.encryption_version,
         OLD.account_number_last_four,
         OLD.account_number_fingerprint,
         OLD.registered_address,
         OLD.registered_address_fingerprint,
         OLD.sender_name
       )
    THEN
      RAISE EXCEPTION
        'LIVE carrier sender account cannot change during a prepared diagnostic';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_carrier_shipping_diagnostic_label
  ON operations_carrier_rate_test_labels;
CREATE TRIGGER validate_operations_carrier_shipping_diagnostic_label
BEFORE INSERT ON operations_carrier_rate_test_labels
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_carrier_shipping_diagnostic_lineage();

DROP TRIGGER IF EXISTS validate_operations_carrier_shipping_diagnostic_attempt
  ON operations_carrier_rate_test_label_attempts;
CREATE TRIGGER validate_operations_carrier_shipping_diagnostic_attempt
BEFORE INSERT ON operations_carrier_rate_test_label_attempts
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_carrier_shipping_diagnostic_lineage();

DROP TRIGGER IF EXISTS
  maintain_operations_carrier_shipping_diagnostic_authority_lease
  ON operations_carrier_rate_test_label_attempts;
CREATE TRIGGER
  maintain_operations_carrier_shipping_diagnostic_authority_lease
AFTER INSERT OR UPDATE OR DELETE
ON operations_carrier_rate_test_label_attempts
FOR EACH ROW EXECUTE FUNCTION
  maintain_operations_carrier_shipping_diagnostic_authority_lease();

DROP TRIGGER IF EXISTS
  protect_operations_carrier_shipping_diagnostic_activation
  ON operations_activation_scopes;
CREATE TRIGGER protect_operations_carrier_shipping_diagnostic_activation
BEFORE UPDATE ON operations_activation_scopes
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_carrier_shipping_diagnostic_authority();

DROP TRIGGER IF EXISTS
  protect_operations_carrier_shipping_diagnostic_integration
  ON operations_integration_accounts;
CREATE TRIGGER protect_operations_carrier_shipping_diagnostic_integration
BEFORE UPDATE ON operations_integration_accounts
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_carrier_shipping_diagnostic_authority();

DROP TRIGGER IF EXISTS
  protect_operations_carrier_shipping_diagnostic_credential
  ON operations_carrier_credentials;
CREATE TRIGGER protect_operations_carrier_shipping_diagnostic_credential
BEFORE UPDATE ON operations_carrier_credentials
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_carrier_shipping_diagnostic_authority();

DROP TRIGGER IF EXISTS
  protect_operations_carrier_shipping_diagnostic_account
  ON operations_carrier_accounts;
CREATE TRIGGER protect_operations_carrier_shipping_diagnostic_account
BEFORE UPDATE ON operations_carrier_accounts
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_carrier_shipping_diagnostic_authority();

COMMENT ON FUNCTION validate_operations_carrier_shipping_diagnostic_lineage()
IS 'Binds Ship to immutable rate/account/credential evidence and binds a later void to that exact provider/account plus the current verified credential, without reauthorizing purchase capability.';

COMMENT ON FUNCTION protect_operations_carrier_shipping_diagnostic_authority()
IS 'Prevents Active, LIVE capability, verified credential, and sender-account authority from changing while a production diagnostic Ship has a prepared provider outcome.';

COMMENT ON FUNCTION
  maintain_operations_carrier_shipping_diagnostic_authority_lease()
IS 'Maintains durable prepared-production Ship lease counters on every authority row; terminal attempt evidence releases the lease.';
