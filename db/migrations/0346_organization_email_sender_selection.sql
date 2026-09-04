ALTER TABLE crm_integration_actions
  DROP CONSTRAINT IF EXISTS crm_integration_actions_communication_snapshot_valid;

ALTER TABLE crm_integration_actions
  ADD CONSTRAINT crm_integration_actions_communication_snapshot_valid CHECK (
    (
      communication_binding_source IS NULL
      AND communication_credential_owner_email IS NULL
      AND communication_connection_id IS NULL
      AND communication_account_email IS NULL
      AND communication_identity_email IS NULL
      AND communication_calendar_id IS NULL
    ) OR (
      communication_binding_source IN (
        'organization',
        'user-default',
        'meeting-override',
        'email-override'
      )
      AND workspace_organization_id IS NOT NULL
      AND communication_credential_owner_email IS NOT NULL
      AND communication_connection_id IS NOT NULL
      AND communication_account_email IS NOT NULL
      AND communication_identity_email IS NOT NULL
    )
  );

COMMENT ON COLUMN crm_integration_actions.communication_binding_source IS
  'Immutable identity source: organization default, legacy user default, reviewed per-meeting Calendar override, or reviewed per-action Gmail override.';
