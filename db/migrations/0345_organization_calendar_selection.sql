ALTER TABLE organization_communication_bindings
  DROP CONSTRAINT IF EXISTS organization_communication_bindings_calendar_id_valid;

ALTER TABLE organization_communication_bindings
  ADD CONSTRAINT organization_communication_bindings_calendar_id_valid CHECK (
    (app = 'google-mail' AND calendar_id IS NULL)
    OR (
      app = 'google-calendar'
      AND calendar_id IS NOT NULL
      AND calendar_id = btrim(calendar_id)
      AND char_length(calendar_id) BETWEEN 1 AND 1024
      AND calendar_id !~ '[[:cntrl:]]'
    )
  );

COMMENT ON COLUMN organization_communication_bindings.calendar_id IS
  'Provider-verified writable Google Calendar ID selected independently for this organization.';

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
      communication_binding_source IN ('organization', 'user-default', 'meeting-override')
      AND workspace_organization_id IS NOT NULL
      AND communication_credential_owner_email IS NOT NULL
      AND communication_connection_id IS NOT NULL
      AND communication_account_email IS NOT NULL
      AND communication_identity_email IS NOT NULL
    )
  );

COMMENT ON COLUMN crm_integration_actions.communication_binding_source IS
  'Immutable identity source: organization default, legacy user default, or reviewed per-meeting override.';
