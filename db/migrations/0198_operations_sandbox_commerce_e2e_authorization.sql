-- Exact, expiring operator authority for an order-bound commerce E2E test.
-- This does not alter production carrier execution or permit sandbox evidence
-- to satisfy Active production lineage.

INSERT INTO global_reference_entity_types (
  prefix, entity_type, display_name
)
VALUES (
  'gsea',
  'operations.sandbox_commerce_e2e_authorization',
  'Sandbox commerce E2E authorization'
)
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_sandbox_commerce_e2e_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gsea'),
  organization_id uuid NOT NULL,
  order_id uuid NOT NULL,
  external_order_id text NOT NULL,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'consumed', 'revoked', 'expired')),
  confirmation_statement_version text NOT NULL
    CHECK (confirmation_statement_version = 'sandbox-commerce-e2e-v1'),
  confirmation_hash text NOT NULL CHECK (confirmation_hash ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL,
  authorized_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by text REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_sandbox_commerce_e2e_authorizations_global_valid
    CHECK (global_id ~ '^gsea[0-9]{7}$'),
  CONSTRAINT operations_sandbox_commerce_e2e_authorizations_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_sandbox_commerce_e2e_authorizations_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_sandbox_commerce_e2e_authorizations_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_sandbox_commerce_e2e_authorizations_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_sandbox_commerce_e2e_authorizations_text_valid CHECK (
    length(btrim(external_order_id)) BETWEEN 1 AND 512
    AND external_order_id !~ '[[:cntrl:]]'
    AND length(btrim(reason)) BETWEEN 8 AND 500
    AND reason !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_sandbox_commerce_e2e_authorizations_time_valid CHECK (
    expires_at > authorized_at
    AND expires_at <= authorized_at + interval '24 hours'
  ),
  CONSTRAINT operations_sandbox_commerce_e2e_authorizations_consumption_valid
    CHECK (
      (state = 'consumed' AND consumed_at IS NOT NULL AND consumed_by IS NOT NULL)
      OR (state <> 'consumed' AND consumed_at IS NULL AND consumed_by IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS
  operations_sandbox_commerce_e2e_authorizations_order_idx
ON operations_sandbox_commerce_e2e_authorizations (
  organization_id, order_id, authorized_at DESC
);

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_sandbox_commerce_e2e_authorizations_active_order_unique
ON operations_sandbox_commerce_e2e_authorizations (
  organization_id, order_id
)
WHERE state = 'active';

CREATE OR REPLACE FUNCTION protect_sandbox_commerce_e2e_authorization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Sandbox commerce E2E authorizations cannot be deleted';
  END IF;
  IF ROW(
    NEW.global_id, NEW.organization_id, NEW.order_id, NEW.external_order_id,
    NEW.confirmation_statement_version, NEW.confirmation_hash, NEW.reason,
    NEW.authorized_by, NEW.authorized_at, NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id, OLD.organization_id, OLD.order_id, OLD.external_order_id,
    OLD.confirmation_statement_version, OLD.confirmation_hash, OLD.reason,
    OLD.authorized_by, OLD.authorized_at, OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'Sandbox commerce E2E authorization identity is immutable';
  END IF;
  IF OLD.state <> 'active' THEN
    RAISE EXCEPTION 'Terminal sandbox commerce E2E authorizations are immutable';
  END IF;
  IF NEW.state NOT IN ('consumed', 'revoked', 'expired') THEN
    RAISE EXCEPTION 'Sandbox commerce E2E authorization transition is invalid';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_sandbox_commerce_e2e_authorization_write
  ON operations_sandbox_commerce_e2e_authorizations;
CREATE TRIGGER protect_sandbox_commerce_e2e_authorization_write
BEFORE UPDATE OR DELETE ON operations_sandbox_commerce_e2e_authorizations
FOR EACH ROW EXECUTE FUNCTION protect_sandbox_commerce_e2e_authorization();

COMMENT ON TABLE operations_sandbox_commerce_e2e_authorizations IS
  'Exact expiring operator consent for one order-bound sandbox label, inventory, and commerce-writeback validation. It is not production carrier authority.';
