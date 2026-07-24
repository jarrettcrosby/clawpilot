CREATE OR REPLACE FUNCTION enforce_demo_managed_pipeline_access()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workspace_organization_id = '10000000-0000-4000-8000-000000000001'::uuid
    AND NOT NEW.reference_access_disabled
    AND lower(NEW.owner_email) <> 'demo-system@clawpilot.example'
  THEN
    RAISE EXCEPTION 'The demo workspace only permits its managed pipeline'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_demo_managed_pipeline_access
  ON pipeline_spaces;
CREATE TRIGGER trg_enforce_demo_managed_pipeline_access
BEFORE INSERT OR UPDATE OF
  workspace_organization_id, owner_email, reference_access_disabled
ON pipeline_spaces
FOR EACH ROW EXECUTE FUNCTION enforce_demo_managed_pipeline_access();

COMMENT ON FUNCTION enforce_demo_managed_pipeline_access() IS
  'Prevents authenticated demo visitors from reprovisioning personal pipelines after the managed demo seed completes.';
