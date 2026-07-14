CREATE TABLE IF NOT EXISTS google_workspace_integration (
  singleton_id smallint PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
  api_key_ciphertext bytea,
  api_key_iv bytea,
  api_key_tag bytea,
  api_key_last_four text,
  service_account_ciphertext bytea,
  service_account_iv bytea,
  service_account_tag bytea,
  project_id text,
  service_account_email text,
  private_key_id text,
  credential_version integer NOT NULL DEFAULT 0,
  selected_shared_drive_id text,
  selected_shared_drive_name text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT google_workspace_api_key_material_complete CHECK (
    (
      api_key_ciphertext IS NULL
      AND api_key_iv IS NULL
      AND api_key_tag IS NULL
      AND api_key_last_four IS NULL
    ) OR (
      octet_length(api_key_ciphertext) > 0
      AND octet_length(api_key_iv) = 12
      AND octet_length(api_key_tag) = 16
      AND char_length(api_key_last_four) = 4
    )
  ),
  CONSTRAINT google_workspace_service_account_material_complete CHECK (
    (
      service_account_ciphertext IS NULL
      AND service_account_iv IS NULL
      AND service_account_tag IS NULL
      AND project_id IS NULL
      AND service_account_email IS NULL
      AND private_key_id IS NULL
    ) OR (
      octet_length(service_account_ciphertext) > 0
      AND octet_length(service_account_iv) = 12
      AND octet_length(service_account_tag) = 16
      AND project_id ~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
      AND service_account_email = lower(btrim(service_account_email))
      AND service_account_email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$'
      AND private_key_id ~ '^[A-Za-z0-9_-]{8,128}$'
    )
  ),
  CONSTRAINT google_workspace_credential_version_valid CHECK (credential_version >= 0),
  CONSTRAINT google_workspace_shared_drive_binding_complete CHECK (
    (selected_shared_drive_id IS NULL) = (selected_shared_drive_name IS NULL)
    AND (selected_shared_drive_id IS NULL OR service_account_email IS NOT NULL)
  ),
  CONSTRAINT google_workspace_shared_drive_id_valid CHECK (
    selected_shared_drive_id IS NULL OR (
      selected_shared_drive_id = btrim(selected_shared_drive_id)
      AND char_length(selected_shared_drive_id) BETWEEN 1 AND 256
      AND selected_shared_drive_id ~ '^[A-Za-z0-9_-]+$'
    )
  ),
  CONSTRAINT google_workspace_shared_drive_name_valid CHECK (
    selected_shared_drive_name IS NULL OR (
      selected_shared_drive_name = btrim(selected_shared_drive_name)
      AND char_length(selected_shared_drive_name) BETWEEN 1 AND 200
      AND selected_shared_drive_name !~ '[[:cntrl:]]'
    )
  )
);

ALTER TABLE pipeline_spaces
  ADD COLUMN IF NOT EXISTS provisioning_status text NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS provisioning_error text,
  ADD COLUMN IF NOT EXISTS provisioning_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS provisioning_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS provisioning_last_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS provisioning_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS drive_folder_id text,
  ADD COLUMN IF NOT EXISTS provisioning_sheet_id text,
  ADD COLUMN IF NOT EXISTS google_service_account_email text,
  ADD COLUMN IF NOT EXISTS google_shared_drive_id text,
  ADD COLUMN IF NOT EXISTS short_link_id uuid REFERENCES short_links(id) ON DELETE SET NULL;

UPDATE pipeline_spaces
SET provisioning_status = 'ready',
    provisioning_completed_at = COALESCE(provisioning_completed_at, updated_at, now()),
    provisioning_error = NULL
WHERE sheet_id IS NOT NULL
  AND sync_enabled = true;

ALTER TABLE pipeline_spaces
  ADD CONSTRAINT pipeline_spaces_provisioning_status_valid CHECK (
    provisioning_status IN ('not_requested', 'queued', 'provisioning', 'ready', 'failed')
  ),
  ADD CONSTRAINT pipeline_spaces_provisioning_error_length CHECK (
    provisioning_error IS NULL OR char_length(provisioning_error) <= 500
  ),
  ADD CONSTRAINT pipeline_spaces_drive_folder_id_valid CHECK (
    drive_folder_id IS NULL OR (
      drive_folder_id = btrim(drive_folder_id)
      AND char_length(drive_folder_id) BETWEEN 1 AND 256
      AND drive_folder_id ~ '^[A-Za-z0-9_-]+$'
    )
  ),
  ADD CONSTRAINT pipeline_spaces_provisioning_sheet_id_valid CHECK (
    provisioning_sheet_id IS NULL OR (
      provisioning_sheet_id = btrim(provisioning_sheet_id)
      AND char_length(provisioning_sheet_id) BETWEEN 1 AND 256
      AND provisioning_sheet_id ~ '^[A-Za-z0-9_-]+$'
    )
  ),
  ADD CONSTRAINT pipeline_spaces_google_service_account_email_valid CHECK (
    google_service_account_email IS NULL OR (
      google_service_account_email = lower(btrim(google_service_account_email))
      AND google_service_account_email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$'
    )
  ),
  ADD CONSTRAINT pipeline_spaces_google_shared_drive_id_valid CHECK (
    google_shared_drive_id IS NULL OR (
      google_shared_drive_id = btrim(google_shared_drive_id)
      AND char_length(google_shared_drive_id) BETWEEN 1 AND 256
      AND google_shared_drive_id ~ '^[A-Za-z0-9_-]+$'
    )
  ),
  ADD CONSTRAINT pipeline_spaces_google_binding_complete CHECK (
    (google_service_account_email IS NULL) = (google_shared_drive_id IS NULL)
  ),
  ADD CONSTRAINT pipeline_spaces_ready_has_sheet CHECK (
    provisioning_status <> 'ready' OR (sheet_id IS NOT NULL AND sync_enabled = true)
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pipeline_spaces
    WHERE sheet_id IS NOT NULL
    GROUP BY sheet_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce pipeline Sheet ownership: duplicate sheet_id values exist';
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_pipeline_spaces_single_sync_source;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_spaces_sheet_id_unique
  ON pipeline_spaces (sheet_id)
  WHERE sheet_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_spaces_provisioning_sheet_id_unique
  ON pipeline_spaces (provisioning_sheet_id)
  WHERE provisioning_sheet_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_spaces_drive_folder_id_unique
  ON pipeline_spaces (drive_folder_id)
  WHERE drive_folder_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_spaces_short_link_id_unique
  ON pipeline_spaces (short_link_id)
  WHERE short_link_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pipeline_spaces_provisioning_status
  ON pipeline_spaces (provisioning_status, provisioning_last_attempted_at, updated_at);

CREATE INDEX IF NOT EXISTS idx_pipeline_spaces_google_binding
  ON pipeline_spaces (google_service_account_email, google_shared_drive_id)
  WHERE google_service_account_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS pipeline_google_permissions (
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  resource_id text NOT NULL,
  permission_id text NOT NULL,
  user_email text NOT NULL,
  google_role text NOT NULL CHECK (google_role IN ('reader', 'writer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_reconciled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pipeline_id, resource_id, user_email),
  UNIQUE (pipeline_id, resource_id, permission_id),
  CONSTRAINT pipeline_google_permissions_resource_id_valid CHECK (
    resource_id = btrim(resource_id)
    AND char_length(resource_id) BETWEEN 1 AND 256
    AND resource_id ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT pipeline_google_permissions_permission_id_valid CHECK (
    permission_id = btrim(permission_id)
    AND char_length(permission_id) BETWEEN 1 AND 512
    AND permission_id ~ '^[!-~]+$'
  ),
  CONSTRAINT pipeline_google_permissions_email_valid CHECK (
    user_email = lower(btrim(user_email))
    AND char_length(user_email) BETWEEN 3 AND 254
    AND user_email ~ '^[!-~]+$'
  )
);

CREATE INDEX IF NOT EXISTS idx_pipeline_google_permissions_pipeline
  ON pipeline_google_permissions (pipeline_id, resource_id, updated_at DESC);
