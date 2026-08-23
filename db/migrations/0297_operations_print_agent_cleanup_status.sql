-- Local print-agent removal may need to prove the server result after the
-- current credential was rotated. Retained verifiers are intentionally usable
-- only by the cleanup-status endpoint; ordinary claim/result authentication
-- continues to read only operations_print_agents.secret_hash for active agents.

CREATE TABLE IF NOT EXISTS operations_print_agent_cleanup_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  print_agent_id uuid NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  retained_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_print_agent_cleanup_credentials_agent_fkey
    FOREIGN KEY (organization_id, print_agent_id)
    REFERENCES operations_print_agents(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_print_agent_cleanup_credentials_version_unique
    UNIQUE (organization_id, print_agent_id, credential_version),
  CONSTRAINT operations_print_agent_cleanup_credentials_hash_unique
    UNIQUE (organization_id, print_agent_id, secret_hash)
);

COMMENT ON TABLE operations_print_agent_cleanup_credentials IS
  'Append-only verifiers for pre-rotation print-agent credentials. They authorize only redacted cleanup-status reconciliation.';

CREATE TABLE IF NOT EXISTS operations_print_agent_cleanup_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  print_agent_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL
    CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  response_entries_json text NOT NULL CHECK (
    length(response_entries_json) BETWEEN 2 AND 65536
    AND jsonb_typeof(response_entries_json::jsonb) = 'array'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_print_agent_cleanup_receipts_agent_fkey
    FOREIGN KEY (organization_id, print_agent_id)
    REFERENCES operations_print_agents(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_print_agent_cleanup_receipts_idempotency_present
    CHECK (
      idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'
    ),
  CONSTRAINT operations_print_agent_cleanup_receipts_idempotency_unique
    UNIQUE (organization_id, print_agent_id, idempotency_key)
);

COMMENT ON TABLE operations_print_agent_cleanup_receipts IS
  'Atomic, append-only cleanup-status responses. Stored text makes lost-response replay byte-stable without retaining request payloads.';

CREATE OR REPLACE FUNCTION retain_operations_print_agent_cleanup_credential()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.secret_hash IS DISTINCT FROM OLD.secret_hash THEN
    INSERT INTO operations_print_agent_cleanup_credentials (
      organization_id,
      print_agent_id,
      credential_version,
      secret_hash,
      retained_at
    ) VALUES (
      OLD.organization_id,
      OLD.id,
      OLD.credential_version,
      OLD.secret_hash,
      clock_timestamp()
    )
    ON CONFLICT (organization_id, print_agent_id, credential_version)
    DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS retain_operations_print_agent_cleanup_credential_write
  ON operations_print_agents;
CREATE TRIGGER retain_operations_print_agent_cleanup_credential_write
AFTER UPDATE OF secret_hash ON operations_print_agents
FOR EACH ROW
WHEN (NEW.secret_hash IS DISTINCT FROM OLD.secret_hash)
EXECUTE FUNCTION retain_operations_print_agent_cleanup_credential();

CREATE OR REPLACE FUNCTION protect_operations_print_agent_cleanup_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Print-agent cleanup authentication and replay evidence is append-only';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_print_agent_cleanup_credential_write
  ON operations_print_agent_cleanup_credentials;
CREATE TRIGGER protect_operations_print_agent_cleanup_credential_write
BEFORE UPDATE OR DELETE ON operations_print_agent_cleanup_credentials
FOR EACH ROW EXECUTE FUNCTION protect_operations_print_agent_cleanup_evidence();

DROP TRIGGER IF EXISTS protect_operations_print_agent_cleanup_receipt_write
  ON operations_print_agent_cleanup_receipts;
CREATE TRIGGER protect_operations_print_agent_cleanup_receipt_write
BEFORE UPDATE OR DELETE ON operations_print_agent_cleanup_receipts
FOR EACH ROW EXECUTE FUNCTION protect_operations_print_agent_cleanup_evidence();
