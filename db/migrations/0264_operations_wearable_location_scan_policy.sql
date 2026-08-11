-- Optional location-first verification for wearable picking. A missing policy
-- row is intentionally equivalent to OFF; this migration never opts an
-- existing warehouse into an additional scan step.

CREATE TABLE IF NOT EXISTS operations_wearable_location_scan_policies (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL,
  location_scan_required boolean NOT NULL DEFAULT false,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, warehouse_id),
  CONSTRAINT operations_wearable_location_scan_policy_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT
);

COMMENT ON TABLE operations_wearable_location_scan_policies IS
  'Explicit per-warehouse wearable location-first verification. Missing rows and false both mean disabled.';

CREATE TABLE IF NOT EXISTS operations_wearable_location_scan_policy_commands (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  warehouse_id uuid NOT NULL,
  actor_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  expected_row_version bigint NOT NULL CHECK (expected_row_version >= 0),
  requested_location_scan_required boolean NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, idempotency_key),
  CONSTRAINT operations_wearable_location_scan_command_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_wearable_location_scan_command_key_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_wearable_location_scan_command_result_object CHECK (
    jsonb_typeof(result) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS idx_operations_wearable_location_scan_commands_created
  ON operations_wearable_location_scan_policy_commands (
    organization_id, created_at DESC
  );

CREATE OR REPLACE FUNCTION reject_operations_wearable_location_scan_command_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operations_wearable_location_scan_policy_commands rows are immutable';
END;
$$;

DROP TRIGGER IF EXISTS operations_wearable_location_scan_commands_immutable
  ON operations_wearable_location_scan_policy_commands;
CREATE TRIGGER operations_wearable_location_scan_commands_immutable
BEFORE UPDATE OR DELETE ON operations_wearable_location_scan_policy_commands
FOR EACH ROW EXECUTE FUNCTION reject_operations_wearable_location_scan_command_mutation();
