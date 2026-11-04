-- Reservations are per exact CRM account, not per display name or Project card.
-- No settings/defaults, provider writes, existing-row backfill or activation.
CREATE TABLE IF NOT EXISTS crm_customer_drive_folders (
  account_id uuid PRIMARY KEY REFERENCES crm_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  account_global_id text NOT NULL,
  shared_drive_id text NOT NULL,
  customers_parent_id text NOT NULL,
  service_account_email text NOT NULL,
  plan jsonb NOT NULL,
  root_folder_id text GENERATED ALWAYS AS (plan #>> '{nodes,0,id}') STORED,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','ready')),
  publication_status text NOT NULL DEFAULT 'pending'
    CHECK (publication_status IN ('pending','published','manual_override')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  CONSTRAINT crm_customer_folder_plan_scope CHECK ((
    plan->>'version'='1' AND jsonb_typeof(plan->'nodes')='array'
    AND jsonb_array_length(plan->'nodes')=8
    AND plan->'scope'=jsonb_build_object(
      'accountId',account_id::text,'pipelineId',pipeline_id::text,'workspaceId',workspace_id::text,
      'accountGlobalId',account_global_id,'sharedDriveId',shared_drive_id,
      'customersParentId',customers_parent_id,'serviceAccountEmail',service_account_email)
    AND (plan #>> '{nodes,0,id}') ~ '^[A-Za-z0-9_-]+$'
    AND length(plan #>> '{nodes,0,id}') BETWEEN 1 AND 256
  ) IS TRUE),
  CONSTRAINT crm_customer_folder_root_unique UNIQUE(shared_drive_id,root_folder_id)
);
