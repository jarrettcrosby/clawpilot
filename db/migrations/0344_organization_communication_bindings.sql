CREATE TABLE IF NOT EXISTS organization_communication_bindings (
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  app text NOT NULL,
  credential_owner_email text NOT NULL,
  maton_connection_id text NOT NULL,
  account_email text NOT NULL,
  identity_email text NOT NULL,
  calendar_id text,
  status text NOT NULL DEFAULT 'active',
  verified_at timestamptz NOT NULL,
  verified_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, app),
  CONSTRAINT organization_communication_bindings_app_valid CHECK (
    app IN ('google-mail', 'google-calendar')
  ),
  CONSTRAINT organization_communication_bindings_status_valid CHECK (
    status IN ('active', 'disabled')
  ),
  CONSTRAINT organization_communication_bindings_connection_id_valid CHECK (
    maton_connection_id = btrim(maton_connection_id)
    AND char_length(maton_connection_id) BETWEEN 1 AND 512
    AND maton_connection_id ~ '^[!-~]+$'
  ),
  CONSTRAINT organization_communication_bindings_account_email_valid CHECK (
    account_email = lower(btrim(account_email))
    AND char_length(account_email) BETWEEN 3 AND 254
    AND account_email ~ '^[!-~]+$'
  ),
  CONSTRAINT organization_communication_bindings_identity_email_valid CHECK (
    identity_email = lower(btrim(identity_email))
    AND char_length(identity_email) BETWEEN 3 AND 254
    AND identity_email ~ '^[!-~]+$'
  ),
  CONSTRAINT organization_communication_bindings_calendar_id_valid CHECK (
    (app = 'google-mail' AND calendar_id IS NULL)
    OR (app = 'google-calendar' AND calendar_id = 'primary')
  ),
  CONSTRAINT organization_communication_bindings_owner_membership_fkey
    FOREIGN KEY (credential_owner_email, organization_id)
    REFERENCES app_user_organization_memberships (user_email, organization_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_organization_communication_bindings_owner
  ON organization_communication_bindings (
    credential_owner_email,
    maton_connection_id,
    status,
    organization_id
  );

ALTER TABLE crm_integration_actions
  ADD COLUMN IF NOT EXISTS workspace_organization_id uuid
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS communication_credential_owner_email text,
  ADD COLUMN IF NOT EXISTS communication_connection_id text,
  ADD COLUMN IF NOT EXISTS communication_account_email text,
  ADD COLUMN IF NOT EXISTS communication_identity_email text,
  ADD COLUMN IF NOT EXISTS communication_calendar_id text,
  ADD COLUMN IF NOT EXISTS communication_binding_source text;

-- The pipeline relationship provides an exact organization for historical
-- actions. Communication identity stays null because it was not snapshotted
-- when those actions were queued.
UPDATE crm_integration_actions action
SET workspace_organization_id = pipeline.workspace_organization_id
FROM pipeline_spaces pipeline
WHERE pipeline.id = action.pipeline_id
  AND action.workspace_organization_id IS NULL;

ALTER TABLE crm_integration_actions
  ADD CONSTRAINT crm_integration_actions_communication_owner_email_valid CHECK (
    communication_credential_owner_email IS NULL OR (
      communication_credential_owner_email = lower(btrim(communication_credential_owner_email))
      AND char_length(communication_credential_owner_email) BETWEEN 3 AND 254
      AND communication_credential_owner_email ~ '^[!-~]+$'
    )
  ),
  ADD CONSTRAINT crm_integration_actions_communication_connection_id_valid CHECK (
    communication_connection_id IS NULL OR (
      communication_connection_id = btrim(communication_connection_id)
      AND char_length(communication_connection_id) BETWEEN 1 AND 512
      AND communication_connection_id ~ '^[!-~]+$'
    )
  ),
  ADD CONSTRAINT crm_integration_actions_communication_account_email_valid CHECK (
    communication_account_email IS NULL OR (
      communication_account_email = lower(btrim(communication_account_email))
      AND char_length(communication_account_email) BETWEEN 3 AND 254
      AND communication_account_email ~ '^[!-~]+$'
    )
  ),
  ADD CONSTRAINT crm_integration_actions_communication_identity_email_valid CHECK (
    communication_identity_email IS NULL OR (
      communication_identity_email = lower(btrim(communication_identity_email))
      AND char_length(communication_identity_email) BETWEEN 3 AND 254
      AND communication_identity_email ~ '^[!-~]+$'
    )
  ),
  ADD CONSTRAINT crm_integration_actions_communication_calendar_id_valid CHECK (
    communication_calendar_id IS NULL OR (
      app = 'google-calendar'
      AND communication_calendar_id = btrim(communication_calendar_id)
      AND char_length(communication_calendar_id) BETWEEN 1 AND 1024
      AND communication_calendar_id !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT crm_integration_actions_communication_snapshot_valid CHECK (
    (
      communication_binding_source IS NULL
      AND communication_credential_owner_email IS NULL
      AND communication_connection_id IS NULL
      AND communication_account_email IS NULL
      AND communication_identity_email IS NULL
      AND communication_calendar_id IS NULL
    ) OR (
      communication_binding_source IN ('organization', 'user-default')
      AND workspace_organization_id IS NOT NULL
      AND communication_credential_owner_email IS NOT NULL
      AND communication_connection_id IS NOT NULL
      AND communication_account_email IS NOT NULL
      AND communication_identity_email IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_crm_integration_actions_communication_scope
  ON crm_integration_actions (
    workspace_organization_id,
    communication_binding_source,
    created_at DESC
  )
  WHERE communication_binding_source IS NOT NULL;
