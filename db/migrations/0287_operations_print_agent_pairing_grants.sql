-- Short-lived, one-time local print-agent pairing grants.
--
-- The hosted browser receives only a high-entropy cppair grant. The durable
-- cpprint credential is generated while redeeming the grant and returned only
-- to the local installer. Neither plaintext secret is persisted.

CREATE TABLE IF NOT EXISTS operations_print_agent_pairing_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL,
  reserved_agent_id uuid NOT NULL UNIQUE,
  name text NOT NULL,
  secret_hash text NOT NULL,
  supported_formats text[] NOT NULL,
  supported_media text[] NOT NULL,
  supported_document_types text[] NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'redeemed', 'expired', 'revoked')),
  request_fingerprint text NOT NULL,
  idempotency_key text NOT NULL,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  expired_at timestamptz,
  revoked_at timestamptz,
  print_agent_id uuid,
  redemption_idempotency_key text,
  redemption_request_fingerprint text,
  CONSTRAINT operations_print_agent_pairing_grants_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_print_agent_pairing_grants_agent_fkey
    FOREIGN KEY (organization_id, print_agent_id)
    REFERENCES operations_print_agents(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_print_agent_pairing_grants_name_present CHECK (
    length(btrim(name)) BETWEEN 1 AND 120
  ),
  CONSTRAINT operations_print_agent_pairing_grants_secret_hash_valid CHECK (
    secret_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT operations_print_agent_pairing_grants_fingerprint_valid CHECK (
    request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT operations_print_agent_pairing_grants_idempotency_present CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 200
  ),
  CONSTRAINT operations_print_agent_pairing_grants_expiry_valid CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '10 minutes'
  ),
  CONSTRAINT operations_print_agent_pairing_grants_formats_valid CHECK (
    cardinality(supported_formats) BETWEEN 1 AND 3
    AND supported_formats <@ ARRAY['ZPL', 'PDF', 'PNG']::text[]
    AND array_position(supported_formats, NULL) IS NULL
  ),
  CONSTRAINT operations_print_agent_pairing_grants_media_valid CHECK (
    cardinality(supported_media) BETWEEN 1 AND 7
    AND supported_media <@ ARRAY[
      'label_2x1', 'label_3x1', 'label_4x2', 'label_4x6', 'label_4x8',
      'letter', 'a4'
    ]::text[]
    AND array_position(supported_media, NULL) IS NULL
  ),
  CONSTRAINT operations_print_agent_pairing_grants_documents_valid CHECK (
    cardinality(supported_document_types) BETWEEN 1 AND 11
    AND supported_document_types <@ ARRAY[
      'shipping_label',
      'packing_slip',
      'pick_ticket',
      'carton_label',
      'pallet_label',
      'bill_of_lading',
      'customs_document',
      'return_label',
      'customer_insert',
      'product_label',
      'location_label'
    ]::text[]
    AND array_position(supported_document_types, NULL) IS NULL
  ),
  CONSTRAINT operations_print_agent_pairing_grants_terminal_state_valid CHECK (
    (
      status = 'pending'
      AND redeemed_at IS NULL
      AND expired_at IS NULL
      AND revoked_at IS NULL
      AND print_agent_id IS NULL
      AND redemption_idempotency_key IS NULL
      AND redemption_request_fingerprint IS NULL
    )
    OR (
      status = 'redeemed'
      AND redeemed_at IS NOT NULL
      AND expired_at IS NULL
      AND revoked_at IS NULL
      AND print_agent_id = reserved_agent_id
      AND length(btrim(redemption_idempotency_key)) BETWEEN 8 AND 200
      AND redemption_request_fingerprint ~ '^[a-f0-9]{64}$'
    )
    OR (
      status = 'expired'
      AND redeemed_at IS NULL
      AND expired_at IS NOT NULL
      AND revoked_at IS NULL
      AND print_agent_id IS NULL
      AND redemption_idempotency_key IS NULL
      AND redemption_request_fingerprint IS NULL
    )
    OR (
      status = 'revoked'
      AND redeemed_at IS NULL
      AND expired_at IS NULL
      AND revoked_at IS NOT NULL
      AND print_agent_id IS NULL
      AND redemption_idempotency_key IS NULL
      AND redemption_request_fingerprint IS NULL
    )
  ),
  CONSTRAINT operations_print_agent_pairing_grants_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_print_agent_pairing_grants_idempotency_unique
    UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_operations_print_agent_pairing_grants_pending
  ON operations_print_agent_pairing_grants (expires_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_operations_print_agent_pairing_grants_warehouse
  ON operations_print_agent_pairing_grants (
    organization_id,
    warehouse_id,
    created_at DESC
  );

COMMENT ON TABLE operations_print_agent_pairing_grants IS
  'Short-lived one-time grants that authorize a local installer to enroll one print agent. Plaintext cppair and cpprint secrets are never persisted.';
COMMENT ON COLUMN operations_print_agent_pairing_grants.secret_hash IS
  'Domain-separated SHA-256 verifier for a server-generated 256-bit cppair secret.';
COMMENT ON COLUMN operations_print_agent_pairing_grants.reserved_agent_id IS
  'Immutable agent UUID used to generate the cpprint credential only during successful redemption.';

CREATE OR REPLACE FUNCTION protect_operations_print_agent_pairing_grant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Print-agent pairing grants cannot be deleted';
  END IF;

  IF ROW(
    NEW.id,
    NEW.organization_id,
    NEW.warehouse_id,
    NEW.reserved_agent_id,
    NEW.name,
    NEW.secret_hash,
    NEW.supported_formats,
    NEW.supported_media,
    NEW.supported_document_types,
    NEW.request_fingerprint,
    NEW.idempotency_key,
    NEW.created_by,
    NEW.created_at,
    NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.organization_id,
    OLD.warehouse_id,
    OLD.reserved_agent_id,
    OLD.name,
    OLD.secret_hash,
    OLD.supported_formats,
    OLD.supported_media,
    OLD.supported_document_types,
    OLD.request_fingerprint,
    OLD.idempotency_key,
    OLD.created_by,
    OLD.created_at,
    OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'Print-agent pairing-grant identity and plan are immutable';
  END IF;

  IF OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Terminal print-agent pairing grants are immutable';
  END IF;

  IF OLD.status = 'pending'
     AND NEW.status NOT IN ('pending', 'redeemed', 'expired', 'revoked') THEN
    RAISE EXCEPTION 'Print-agent pairing-grant transition is invalid';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_print_agent_pairing_grant_write
  ON operations_print_agent_pairing_grants;
CREATE TRIGGER protect_operations_print_agent_pairing_grant_write
BEFORE UPDATE OR DELETE ON operations_print_agent_pairing_grants
FOR EACH ROW
EXECUTE FUNCTION protect_operations_print_agent_pairing_grant();
