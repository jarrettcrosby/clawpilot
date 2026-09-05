-- Preserve both the workspace migration receipt and each separately reviewed
-- provider-rebind completion receipt as immutable cutover evidence.

CREATE OR REPLACE FUNCTION protect_commerce_workspace_migration_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    OLD.event_type = 'operations.commerce_workspace_migration.completed'
    AND (
      OLD.event_key LIKE 'commerce-workspace-migration:commerce-workspace-production-migration-v2:%'
      OR OLD.event_key LIKE 'commerce-workspace-migration:sales-shipping-workspace-production-migration-v3:%'
    )
  ) OR (
    OLD.event_type = 'operations.migrated_provider_rebind.completed'
    AND OLD.event_key LIKE 'migrated-provider-rebind:migrated-production-provider-rebind-v1:%'
  ) THEN
    RAISE EXCEPTION 'Commerce workspace migration receipts are immutable, including provider rebind receipts';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_commerce_workspace_migration_receipt_write
  ON audit_events;
CREATE TRIGGER protect_commerce_workspace_migration_receipt_write
BEFORE UPDATE OR DELETE
ON audit_events
FOR EACH ROW EXECUTE FUNCTION protect_commerce_workspace_migration_receipt();

COMMENT ON FUNCTION protect_commerce_workspace_migration_receipt() IS
  'Rejects updates and deletes of approved commerce workspace migration receipts and one-provider production rebind completion receipts.';
