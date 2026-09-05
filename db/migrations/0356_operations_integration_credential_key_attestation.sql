-- Immutable proof that the configured integration-credential key belongs to
-- this database. The row stores only AES-GCM ciphertext and non-secret
-- metadata; raw key material, a key digest, and the plaintext challenge are
-- deliberately never persisted.

SET LOCAL search_path = public, pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE operations_integration_credential_key_attestations (
  singleton_id smallint PRIMARY KEY DEFAULT 1
    CHECK (singleton_id = 1),
  attestation_version text NOT NULL
    CHECK (
      attestation_version = 'integration-credential-key-attestation-v1'
    ),
  database_identity uuid NOT NULL,
  key_id text NOT NULL
    CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  sentinel_ciphertext bytea NOT NULL
    CHECK (octet_length(sentinel_ciphertext) BETWEEN 32 AND 4096),
  sentinel_iv bytea NOT NULL
    CHECK (octet_length(sentinel_iv) = 12),
  sentinel_tag bytea NOT NULL
    CHECK (octet_length(sentinel_tag) = 16),
  bootstrap_mode text NOT NULL
    CHECK (bootstrap_mode IN ('empty', 'reviewed_adoption')),
  adoption_evidence_sha256 text,
  created_by text NOT NULL
    REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT operations_integration_key_attestation_adoption_valid CHECK (
    (
      bootstrap_mode = 'empty'
      AND adoption_evidence_sha256 IS NULL
    ) OR (
      bootstrap_mode = 'reviewed_adoption'
      AND adoption_evidence_sha256 ~ '^[a-f0-9]{64}$'
    )
  )
);

CREATE OR REPLACE FUNCTION validate_integration_credential_key_attestation_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  current_database_identity text;
  key_backed_rows bigint;
  authorized_actor boolean;
  expected_reviewed_adoption_install_context text;
BEGIN
  -- These SHARE locks conflict with the ROW EXCLUSIVE lock taken by every
  -- INSERT/UPDATE/DELETE writer. They make the empty-store decision and the
  -- singleton insert one atomic database boundary even when this trigger is
  -- reached outside the supported operator CLI.
  LOCK TABLE
    operations_carrier_accounts,
    operations_carrier_credentials,
    operations_commerce_credentials,
    operations_commerce_intake_continuations,
    operations_commerce_intake_read_intents,
    operations_commerce_oauth_installations,
    operations_commerce_order_candidates,
    operations_commerce_order_workbench,
    operations_commerce_webhook_receipts,
    operations_order_shipment_address_working_copies
  IN SHARE MODE;

  SELECT CASE
           WHEN setting.value->>'id'
             ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             THEN lower(setting.value->>'id')
           ELSE NULL
         END
  INTO current_database_identity
  FROM app_settings setting
  WHERE setting.key = 'deployment.database.identity';

  IF current_database_identity IS NULL
     OR NEW.database_identity::text <> current_database_identity THEN
    RAISE EXCEPTION
      'Integration credential key attestation database identity mismatch';
  END IF;

  SELECT true
  INTO authorized_actor
  FROM app_users app_user
  WHERE app_user.email = NEW.created_by
    AND app_user.status = 'active'
    AND app_user.role IN ('owner', 'admin')
  FOR UPDATE;

  IF authorized_actor IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'Integration credential key attestation requires an active owner or admin';
  END IF;

  -- A reviewed-adoption row can only be installed through the deliberate CLI
  -- protocol in the same transaction. The context is non-secret, but it is
  -- bound to the reviewed plan digest, actor, database/key metadata, and newly
  -- generated ciphertext. This prevents a generic or stale direct INSERT from
  -- satisfying the database boundary accidentally. The database owner remains
  -- part of the trusted migration/operator boundary.
  IF NEW.bootstrap_mode = 'reviewed_adoption' THEN
    expected_reviewed_adoption_install_context := encode(
      digest(
        convert_to(
          'clawpilot:integration-credential-key-attestation:reviewed-adoption-install:v1'
          || E'\n' || NEW.attestation_version
          || E'\n' || NEW.database_identity::text
          || E'\n' || NEW.key_id
          || E'\n' || NEW.adoption_evidence_sha256
          || E'\n' || NEW.created_by
          || E'\n',
          'UTF8'
        )
        || NEW.sentinel_ciphertext
        || NEW.sentinel_iv
        || NEW.sentinel_tag,
        'sha256'
      ),
      'hex'
    );

    IF current_setting(
         'clawpilot.integration_credential_key_attestation_reviewed_adoption_install_context',
         true
       ) IS DISTINCT FROM expected_reviewed_adoption_install_context THEN
      RAISE EXCEPTION
        'Integration credential key reviewed adoption requires the transaction-local installation context';
    END IF;
  END IF;

  IF NEW.bootstrap_mode = 'empty' THEN
    SELECT
      (SELECT count(*) FROM operations_commerce_credentials)
      + (SELECT count(*) FROM operations_carrier_credentials)
      + (SELECT count(*) FROM operations_carrier_accounts)
      + (SELECT count(*) FROM operations_commerce_oauth_installations
         WHERE application_credential_ciphertext IS NOT NULL)
      + (SELECT count(*) FROM operations_commerce_webhook_receipts
         WHERE payload_ciphertext IS NOT NULL)
      + (SELECT count(*) FROM operations_commerce_order_candidates
         WHERE party_snapshot_ciphertext IS NOT NULL
            OR ship_to_snapshot_ciphertext IS NOT NULL)
      + (SELECT count(*) FROM operations_commerce_intake_read_intents
         WHERE response_ciphertext IS NOT NULL)
      + (SELECT count(*) FROM operations_commerce_intake_continuations
         WHERE cursor_ciphertext IS NOT NULL)
      + (SELECT count(*) FROM operations_commerce_order_workbench
         WHERE ship_to_ciphertext IS NOT NULL)
      + (SELECT count(*)
         FROM operations_order_shipment_address_working_copies
         WHERE ship_to_ciphertext IS NOT NULL)
    INTO key_backed_rows;

    IF key_backed_rows <> 0 THEN
      RAISE EXCEPTION
        'Integration credential key attestation empty bootstrap requires an empty key-backed store';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_integration_credential_key_attestation_insert
  ON operations_integration_credential_key_attestations;
CREATE TRIGGER validate_integration_credential_key_attestation_insert
BEFORE INSERT ON operations_integration_credential_key_attestations
FOR EACH ROW EXECUTE FUNCTION
  validate_integration_credential_key_attestation_insert();

CREATE OR REPLACE FUNCTION reject_integration_credential_key_attestation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'Integration credential key attestations are immutable';
END;
$$;

DROP TRIGGER IF EXISTS reject_integration_credential_key_attestation_update_delete
  ON operations_integration_credential_key_attestations;
CREATE TRIGGER reject_integration_credential_key_attestation_update_delete
BEFORE UPDATE OR DELETE ON operations_integration_credential_key_attestations
FOR EACH ROW EXECUTE FUNCTION
  reject_integration_credential_key_attestation_mutation();

DROP TRIGGER IF EXISTS reject_integration_credential_key_attestation_truncate
  ON operations_integration_credential_key_attestations;
CREATE TRIGGER reject_integration_credential_key_attestation_truncate
BEFORE TRUNCATE ON operations_integration_credential_key_attestations
FOR EACH STATEMENT EXECUTE FUNCTION
  reject_integration_credential_key_attestation_mutation();

COMMENT ON TABLE operations_integration_credential_key_attestations IS
  'Immutable singleton proof that one non-secret key ID and the configured integration credential key are bound to this database identity.';
COMMENT ON COLUMN operations_integration_credential_key_attestations.sentinel_ciphertext IS
  'AES-256-GCM ciphertext of a versioned random challenge. The plaintext challenge and any direct key digest are never persisted.';
COMMENT ON COLUMN operations_integration_credential_key_attestations.adoption_evidence_sha256 IS
  'Digest of the separately reviewed, non-secret legacy-footprint adoption evidence; never a key or plaintext-secret digest.';

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. These
-- functions are trigger-only boundaries, and this evidence table has no
-- reason to inherit any ambient PUBLIC table privileges.
REVOKE ALL ON TABLE operations_integration_credential_key_attestations
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  validate_integration_credential_key_attestation_insert()
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  reject_integration_credential_key_attestation_mutation()
  FROM PUBLIC;
