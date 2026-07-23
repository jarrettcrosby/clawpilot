-- Safe carrier sandbox-rate evidence and retirement of the legacy hosted
-- mock-proof workflow. Operational ledger and Global ID history remain intact.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES ('grq', 'operations.carrier_rate_request', 'Carrier rate request')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

ALTER TABLE operations_orders
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archive_reason text,
  ADD COLUMN IF NOT EXISTS archived_by text;

CREATE INDEX IF NOT EXISTS idx_operations_orders_active_workbench
  ON operations_orders (organization_id, status, updated_at DESC, id)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS operations_carrier_rate_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('grq'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('ups_rest', 'fedex_rest', 'usps_rest')),
  environment text NOT NULL CHECK (environment = 'sandbox'),
  purpose text NOT NULL DEFAULT 'sandbox_rate_test'
    CHECK (purpose = 'sandbox_rate_test'),
  adapter_version text NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  redacted_request jsonb NOT NULL,
  redacted_response jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  provider_reference text,
  error_code text,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_rate_requests_global_valid
    CHECK (global_id ~ '^grq[0-9]{7}$'),
  CONSTRAINT operations_carrier_rate_requests_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_rate_requests_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_requests_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_requests_dates_valid
    CHECK (completed_at >= requested_at),
  CONSTRAINT operations_carrier_rate_requests_state_valid CHECK (
    (status = 'succeeded' AND error_code IS NULL)
    OR (status = 'failed' AND error_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_operations_carrier_rate_requests_recent
  ON operations_carrier_rate_requests (organization_id, provider, completed_at DESC, id);

DROP TRIGGER IF EXISTS protect_operations_carrier_rate_requests_mutation
  ON operations_carrier_rate_requests;
CREATE TRIGGER protect_operations_carrier_rate_requests_mutation
BEFORE UPDATE OR DELETE ON operations_carrier_rate_requests
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

-- Release reservations from the retired proof flow while preserving a ledger
-- explanation for every changed materialized balance.
WITH releases AS (
  SELECT reservation.organization_id,
         reservation.position_id,
         sum(reservation.quantity) AS quantity,
         min(orders.global_id) AS source_global_id
  FROM operations_reservations reservation
  JOIN operations_orders orders
    ON orders.organization_id = reservation.organization_id
   AND orders.id = reservation.order_id
  WHERE orders.source_provider = 'mock-commerce'
    AND reservation.status = 'active'
  GROUP BY reservation.organization_id, reservation.position_id
)
INSERT INTO operations_inventory_ledger (
  organization_id, position_id, event_type,
  on_hand_delta, reserved_delta, on_hand_after, reserved_after,
  source_global_id, reason, idempotency_key, occurred_at
)
SELECT position.organization_id,
       position.id,
       'reservation_release',
       0,
       -LEAST(position.reserved_quantity, releases.quantity),
       position.on_hand_quantity,
       GREATEST(0, position.reserved_quantity - releases.quantity),
       releases.source_global_id,
       'Legacy hosted mock proof order retired',
       'retire-mock-proof:' || position.id::text,
       now()
FROM releases
JOIN operations_inventory_positions position
  ON position.organization_id = releases.organization_id
 AND position.id = releases.position_id
ON CONFLICT (organization_id, idempotency_key) DO NOTHING;

WITH releases AS (
  SELECT reservation.organization_id,
         reservation.position_id,
         sum(reservation.quantity) AS quantity
  FROM operations_reservations reservation
  JOIN operations_orders orders
    ON orders.organization_id = reservation.organization_id
   AND orders.id = reservation.order_id
  WHERE orders.source_provider = 'mock-commerce'
    AND reservation.status = 'active'
  GROUP BY reservation.organization_id, reservation.position_id
)
UPDATE operations_inventory_positions position
SET reserved_quantity = GREATEST(0, position.reserved_quantity - releases.quantity),
    version = position.version + 1,
    updated_at = now()
FROM releases
WHERE position.organization_id = releases.organization_id
  AND position.id = releases.position_id;

UPDATE operations_reservations reservation
SET status = 'released', released_at = COALESCE(released_at, now())
FROM operations_orders orders
WHERE orders.organization_id = reservation.organization_id
  AND orders.id = reservation.order_id
  AND orders.source_provider = 'mock-commerce'
  AND reservation.status = 'active';

UPDATE operations_exceptions exception
SET status = 'dismissed',
    resolved_at = COALESCE(resolved_at, now()),
    updated_at = now(),
    details = exception.details || '{"retirementReason":"legacy_mock_proof_retired"}'::jsonb
FROM operations_orders orders
WHERE orders.organization_id = exception.organization_id
  AND orders.id = exception.order_id
  AND orders.source_provider = 'mock-commerce'
  AND exception.status IN ('open', 'acknowledged');

UPDATE operations_orders
SET status = 'cancelled',
    archived_at = COALESCE(archived_at, now()),
    archive_reason = COALESCE(archive_reason, 'legacy_mock_proof_retired'),
    archived_by = COALESCE(archived_by, 'system'),
    updated_at = now(),
    row_version = row_version + 1
WHERE source_provider = 'mock-commerce'
  AND archived_at IS NULL;

UPDATE operations_integration_accounts
SET status = 'disabled', updated_at = now()
WHERE provider IN ('mock-commerce', 'mock-carrier', 'mock-printer')
  AND environment = 'mock';

UPDATE operations_locations location
SET active = false, updated_at = now()
FROM operations_warehouses warehouse
WHERE warehouse.organization_id = location.organization_id
  AND warehouse.id = location.warehouse_id
  AND warehouse.code = 'MOCK-01'
  AND location.active = true;

UPDATE operations_inventory_pools
SET active = false, updated_at = now()
WHERE name ILIKE 'Proof inventory%'
  AND active = true;

UPDATE operations_printers printer
SET status = 'disabled', updated_at = now()
FROM operations_warehouses warehouse
WHERE warehouse.organization_id = printer.organization_id
  AND warehouse.id = printer.warehouse_id
  AND warehouse.code = 'MOCK-01'
  AND printer.status <> 'disabled';

UPDATE operations_rules
SET active = false, updated_at = now()
WHERE name = 'Mock proof ZPL route'
  AND active = true;

UPDATE operations_contracts
SET status = 'terminated', updated_at = now()
WHERE name ILIKE 'Mock proof fulfillment%'
  AND status <> 'terminated';

UPDATE operations_warehouses
SET status = 'inactive', updated_at = now()
WHERE code = 'MOCK-01'
  AND status <> 'inactive';
