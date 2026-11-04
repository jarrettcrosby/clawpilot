-- Explicit operator-account and employee intent registry. Empty on install:
-- no owner/domain/default-workspace inference, enrollment or reader grant.
-- The native-first root-resource delta integration is required before this
-- metadata may authorize any app/native read. Enabled native policy freezes
-- these new intent writes until that exact integration is installed.
CREATE TABLE crm_operator_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  root_workspace_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  owner_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  updated_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (root_workspace_id), UNIQUE (id,root_workspace_id), UNIQUE (id,owner_email),
  FOREIGN KEY (owner_email,root_workspace_id)
    REFERENCES app_user_organization_memberships(user_email,organization_id) ON DELETE RESTRICT
);
CREATE TABLE crm_operator_workspace_bindings (
  operator_account_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  owner_email text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  updated_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_account_id,workspace_id),
  FOREIGN KEY (operator_account_id,owner_email) REFERENCES crm_operator_accounts(id,owner_email) ON DELETE RESTRICT,
  FOREIGN KEY (owner_email,workspace_id)
    REFERENCES app_user_organization_memberships(user_email,organization_id) ON DELETE RESTRICT
);
-- Disabled historical bindings remain attached to their original account;
-- they are not silently rebound when another operator takes ownership.
CREATE UNIQUE INDEX crm_operator_workspace_active_binding
  ON crm_operator_workspace_bindings(workspace_id) WHERE enabled;
CREATE TABLE crm_root_employee_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_account_id uuid NOT NULL,
  user_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  source_workspace_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  updated_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operator_account_id,user_email),
  FOREIGN KEY (operator_account_id,source_workspace_id)
    REFERENCES crm_operator_accounts(id,root_workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (user_email,source_workspace_id)
    REFERENCES app_user_organization_memberships(user_email,organization_id) ON DELETE RESTRICT
);

CREATE FUNCTION clawpilot_crm_root_registry_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE old_row jsonb; new_row jsonb; account_owner text; root_id uuid; target_id uuid;
  native_enabled boolean; active_operation text; active_transition text;
BEGIN
  SELECT enabled,active_operation_id,active_transition_id
    INTO native_enabled,active_operation,active_transition
    FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Native authority control missing' USING ERRCODE='55000'; END IF;
  IF native_enabled OR active_operation IS NOT NULL OR active_transition IS NOT NULL THEN
    RAISE EXCEPTION 'Root CRM intent requires the exact native-first integration' USING ERRCODE='55000';
  END IF;
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Root CRM registry history must be disabled, not removed' USING ERRCODE='55000';
  END IF;
  new_row:=to_jsonb(NEW);
  IF TG_OP='UPDATE' THEN
    old_row:=to_jsonb(OLD);
    IF (old_row-ARRAY['enabled','revision','updated_by','updated_at'])
       IS DISTINCT FROM (new_row-ARRAY['enabled','revision','updated_by','updated_at'])
      OR NEW.revision<>OLD.revision+1 THEN
      RAISE EXCEPTION 'Root CRM identity is permanent and changes require the next revision' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.revision<>1 THEN
    RAISE EXCEPTION 'Root CRM registry must start at revision one' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='crm_operator_accounts' THEN
    account_owner:=NEW.owner_email; root_id:=NEW.root_workspace_id; target_id:=root_id;
    IF NOT EXISTS(SELECT 1 FROM public.workspace_organizations w WHERE w.id=root_id
      AND w.parent_id IS NULL AND w.organization_type='root' AND NOT w.is_demo) THEN
      RAISE EXCEPTION 'Root CRM anchor is not a real root workspace' USING ERRCODE='55000';
    END IF;
  ELSE
    SELECT owner_email,root_workspace_id INTO account_owner,root_id FROM public.crm_operator_accounts
      WHERE id=NEW.operator_account_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Root CRM account missing' USING ERRCODE='55000'; END IF;
    IF TG_TABLE_NAME='crm_operator_workspace_bindings' THEN target_id:=NEW.workspace_id;
    ELSE
      target_id:=root_id;
      IF NEW.source_workspace_id<>root_id OR NEW.user_email=account_owner THEN
        RAISE EXCEPTION 'Root CRM employee source differs from its anchor' USING ERRCODE='55000';
      END IF;
    END IF;
  END IF;
  -- An inactive owner may still disable historical intent. Creating or enabling
  -- intent requires current ownership and an active real operator workspace.
  IF TG_OP='INSERT' OR NEW.enabled THEN
    IF NOT EXISTS(SELECT 1 FROM public.app_user_organization_memberships m
      JOIN public.app_users u ON u.email=m.user_email JOIN public.workspace_organizations w ON w.id=m.organization_id
      WHERE m.user_email=account_owner AND m.organization_id=target_id AND m.role='owner'
        AND m.status='active' AND m.trashed_at IS NULL AND u.status='active' AND NOT w.is_demo) THEN
      RAISE EXCEPTION 'Root CRM intent requires current operator ownership' USING ERRCODE='55000';
    END IF;
  END IF;
  UPDATE public.crm_native_email_publication_control SET generation=generation+1,verified_generation=NULL,
    native_policy_fingerprint=NULL,activation_receipt_hash=NULL,updated_at=now() WHERE singleton;
  RETURN NEW;
END $$;

CREATE TRIGGER crm_operator_accounts_statement_lock BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON crm_operator_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_authority_statement_lock();
CREATE TRIGGER crm_operator_bindings_statement_lock BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON crm_operator_workspace_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_authority_statement_lock();
CREATE TRIGGER crm_employee_grants_statement_lock BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON crm_root_employee_access_grants
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_authority_statement_lock();
CREATE TRIGGER crm_operator_accounts_guard BEFORE INSERT OR UPDATE OR DELETE ON crm_operator_accounts
  FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_root_registry_guard();
CREATE TRIGGER crm_operator_bindings_guard BEFORE INSERT OR UPDATE OR DELETE ON crm_operator_workspace_bindings
  FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_root_registry_guard();
CREATE TRIGGER crm_employee_grants_guard BEFORE INSERT OR UPDATE OR DELETE ON crm_root_employee_access_grants
  FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_root_registry_guard();
CREATE TRIGGER crm_operator_accounts_no_truncate BEFORE TRUNCATE ON crm_operator_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_root_registry_guard();
CREATE TRIGGER crm_operator_bindings_no_truncate BEFORE TRUNCATE ON crm_operator_workspace_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_root_registry_guard();
CREATE TRIGGER crm_employee_grants_no_truncate BEFORE TRUNCATE ON crm_root_employee_access_grants
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_root_registry_guard();
REVOKE ALL ON crm_operator_accounts,crm_operator_workspace_bindings,crm_root_employee_access_grants FROM PUBLIC;
REVOKE ALL ON FUNCTION clawpilot_crm_root_registry_guard() FROM PUBLIC;
