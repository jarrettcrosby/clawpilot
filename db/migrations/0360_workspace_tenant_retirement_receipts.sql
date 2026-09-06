-- Durable, tenant-independent evidence for an explicitly reviewed workspace
-- retirement.  The referenced workspace rows are expected to be absent after
-- the receipt is written, so this table deliberately has no tenant foreign key.

CREATE TABLE IF NOT EXISTS workspace_tenant_retirement_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_digest text NOT NULL UNIQUE CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  receipt_digest text NOT NULL UNIQUE CHECK (receipt_digest ~ '^[a-f0-9]{64}$'),
  script_version text NOT NULL CHECK (
    length(btrim(script_version)) BETWEEN 3 AND 160
    AND script_version !~ '[[:cntrl:]]'
  ),
  environment text NOT NULL CHECK (environment = 'production'),
  railway_project_id uuid NOT NULL,
  railway_environment_id uuid NOT NULL,
  database_identity uuid NOT NULL,
  database_endpoint_sha256 text NOT NULL CHECK (
    database_endpoint_sha256 ~ '^[a-f0-9]{64}$'
  ),
  actor_email text NOT NULL CHECK (
    actor_email = lower(actor_email)
    AND length(actor_email) BETWEEN 3 AND 320
  ),
  target_organizations jsonb NOT NULL CHECK (
    jsonb_typeof(target_organizations) = 'array'
    AND jsonb_array_length(target_organizations) > 0
  ),
  scope_digest text NOT NULL CHECK (scope_digest ~ '^[a-f0-9]{64}$'),
  scope_counts jsonb NOT NULL CHECK (jsonb_typeof(scope_counts) = 'object'),
  retired_references text[] NOT NULL,
  disabled_delete_triggers jsonb NOT NULL CHECK (
    jsonb_typeof(disabled_delete_triggers) = 'array'
  ),
  retired_short_links jsonb NOT NULL CHECK (
    jsonb_typeof(retired_short_links) = 'array'
  ),
  suitecrm_records jsonb NOT NULL CHECK (jsonb_typeof(suitecrm_records) = 'array'),
  external_system_disposition jsonb NOT NULL CHECK (
    jsonb_typeof(external_system_disposition) = 'object'
  ),
  verification jsonb NOT NULL CHECK (jsonb_typeof(verification) = 'object'),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS workspace_tenant_retirement_receipts_completed_idx
  ON workspace_tenant_retirement_receipts (completed_at DESC, id DESC);

CREATE OR REPLACE FUNCTION reject_workspace_tenant_retirement_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Workspace tenant retirement receipts are immutable';
END;
$$;

DROP TRIGGER IF EXISTS reject_workspace_tenant_retirement_receipt_write
  ON workspace_tenant_retirement_receipts;
CREATE TRIGGER reject_workspace_tenant_retirement_receipt_write
BEFORE UPDATE OR DELETE ON workspace_tenant_retirement_receipts
FOR EACH ROW EXECUTE FUNCTION reject_workspace_tenant_retirement_receipt_mutation();

COMMENT ON TABLE workspace_tenant_retirement_receipts IS
  'Immutable, tenant-independent receipt for a reviewed local PostgreSQL workspace retirement. External providers are not deleted by this receipt.';
