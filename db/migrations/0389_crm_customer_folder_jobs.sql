-- Explicit per-workspace setup only. No configured parent, activation, Drive
-- write or historical-account backfill is performed by this migration.
CREATE TABLE IF NOT EXISTS crm_customer_folder_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  shared_drive_id text NOT NULL,
  customers_parent_id text NOT NULL,
  service_account_email text NOT NULL,
  parent_name text NOT NULL CHECK(parent_name='01 Customers'),
  enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL CHECK(revision>0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS crm_customer_folder_jobs (
  account_id uuid PRIMARY KEY REFERENCES crm_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  account_global_id text NOT NULL,
  actor_email text NOT NULL,
  config_revision bigint NOT NULL,
  request_key uuid,
  request_generation integer NOT NULL DEFAULT 0 CHECK(request_generation>=0),
  adopt_root_id text,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','ready','held')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lock_token uuid,
  locked_until timestamptz,
  last_error_code text CHECK(last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_customer_folder_job_request
  ON crm_customer_folder_jobs(workspace_id,request_key) WHERE request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_customer_folder_jobs_due
  ON crm_customer_folder_jobs(available_at,account_id) WHERE status IN ('queued','processing');

CREATE OR REPLACE FUNCTION clawpilot_enqueue_new_customer_folder()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.workspace_organization_id IS NOT NULL
    OR lower(btrim(COALESCE(NEW.account_type,'')))<>'customer'
    OR NEW.source_payload->>'source' IS DISTINCT FROM 'clawpilot'
    OR COALESCE(lower(NEW.source_payload->>'archived'),'false') IN ('true','1','yes')
    THEN RETURN NEW; END IF;
  -- A normal edit or folder publication must not enroll an old customer.
  IF TG_OP='UPDATE' AND lower(btrim(COALESCE(OLD.account_type,'')))='customer'
    THEN RETURN NEW; END IF;
  INSERT INTO public.crm_customer_folder_jobs(
    account_id,pipeline_id,workspace_id,account_global_id,actor_email,config_revision)
  SELECT NEW.id,NEW.pipeline_id,p.workspace_organization_id,NEW.reference_code,
    COALESCE(NEW.updated_by,NEW.created_by),s.revision
  FROM public.pipeline_spaces p JOIN public.workspace_organizations w ON w.id=p.workspace_organization_id
  JOIN public.crm_customer_folder_settings s ON s.workspace_id=w.id AND s.enabled
  WHERE p.id=NEW.pipeline_id AND NOT p.reference_access_disabled AND NOT w.is_demo
    AND COALESCE(NEW.updated_by,NEW.created_by) IS NOT NULL
  ON CONFLICT(account_id) DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_clawpilot_new_customer_folder ON crm_organizations;
CREATE TRIGGER trg_clawpilot_new_customer_folder
AFTER INSERT OR UPDATE OF account_type,source_payload ON crm_organizations
FOR EACH ROW EXECUTE FUNCTION clawpilot_enqueue_new_customer_folder();
