-- Migration 0360 is already deployed and immutable. Add the stronger production
-- database and backup boundary evidence forward-only. Existing receipts cannot
-- be safely reconstructed, so fail closed instead of inventing a backfill.

LOCK TABLE workspace_tenant_retirement_receipts IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM workspace_tenant_retirement_receipts) THEN
    RAISE EXCEPTION
      'Cannot add tenant retirement boundary evidence after receipts exist';
  END IF;
END;
$$;

ALTER TABLE workspace_tenant_retirement_receipts
  ADD COLUMN railway_service_id uuid NOT NULL,
  ADD COLUMN database_name text NOT NULL CHECK (database_name = 'railway'),
  ADD COLUMN database_user text NOT NULL CHECK (database_user = 'postgres'),
  ADD COLUMN postgres_system_identifier text NOT NULL CHECK (
    postgres_system_identifier ~ '^[0-9]{10,30}$'
  ),
  ADD COLUMN backup_evidence jsonb NOT NULL CHECK (
    jsonb_typeof(backup_evidence) = 'object'
    AND backup_evidence->>'sha256' ~ '^[a-f0-9]{64}$'
    AND (backup_evidence->>'bytes')::numeric > 0
  );
