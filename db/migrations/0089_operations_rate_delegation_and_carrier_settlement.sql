-- Carrier-rate delegation, quote provenance, multi-party settlement, and
-- carrier-bill reconciliation.
--
-- Economic roles are contextual to a rate network:
--   platform_operator -> reseller -> shipper
-- Carrier-account ownership is intentionally separate. The account owner may
-- be the platform operator or an authorized reseller. CRM hierarchy never
-- grants rate access by itself.
--
-- Carrier API rates are pro forma. Final carrier cost comes from append-only
-- carrier billing evidence and reconciliation snapshots.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name) VALUES
  ('grn', 'operations.carrier_rate_network', 'Carrier rate network'),
  ('grp', 'operations.carrier_rate_party', 'Carrier rate party'),
  ('gca', 'operations.carrier_account_authorization', 'Carrier account authorization'),
  ('grg', 'operations.carrier_rate_grant', 'Carrier rate grant'),
  ('gru', 'operations.carrier_rate_grant_user', 'Carrier rate grant user'),
  ('grd', 'operations.carrier_rate_directive', 'Carrier rate directive'),
  ('gqs', 'operations.carrier_quote_snapshot', 'Carrier quote snapshot'),
  ('gse', 'operations.settlement_entry', 'Settlement entry'),
  ('gsv', 'operations.settlement_event', 'Settlement event'),
  ('gcb', 'operations.carrier_billing_batch', 'Carrier billing batch'),
  ('gcs', 'operations.carrier_billing_statement', 'Carrier billing statement'),
  ('gba', 'operations.carrier_billing_account_resolution', 'Carrier billing account resolution'),
  ('gcl', 'operations.carrier_billing_charge', 'Carrier billing charge'),
  ('gcm', 'operations.carrier_billing_match', 'Carrier billing match'),
  ('gbr', 'operations.carrier_billing_routing_rule', 'Carrier billing routing rule'),
  ('gbs', 'operations.carrier_billing_shipper_assignment', 'Carrier billing shipper assignment'),
  ('gcr', 'operations.carrier_billing_reconciliation', 'Carrier billing reconciliation')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_carrier_rate_networks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('grn'),
  platform_organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  default_currency text NOT NULL DEFAULT 'USD' CHECK (default_currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'archived')),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_rate_networks_global_valid
    CHECK (global_id ~ '^grn[0-9]{7}$'),
  CONSTRAINT operations_carrier_rate_networks_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_rate_networks_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_networks_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT operations_carrier_rate_networks_id_scope_unique
    UNIQUE (platform_organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_carrier_rate_networks_name
  ON operations_carrier_rate_networks (platform_organization_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS operations_carrier_rate_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('grp'),
  network_id uuid NOT NULL
    REFERENCES operations_carrier_rate_networks(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('platform_operator', 'reseller', 'shipper')),
  entity_type text NOT NULL CHECK (entity_type IN ('workspace_organization', 'crm_customer')),
  workspace_organization_id uuid
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  crm_pipeline_id uuid REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  crm_customer_id uuid,
  display_name text NOT NULL,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_rate_parties_global_valid
    CHECK (global_id ~ '^grp[0-9]{7}$'),
  CONSTRAINT operations_carrier_rate_parties_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_rate_parties_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_parties_customer_fkey
    FOREIGN KEY (crm_pipeline_id, crm_customer_id)
    REFERENCES crm_organizations(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_parties_entity_valid CHECK (
    (
      entity_type = 'workspace_organization'
      AND workspace_organization_id IS NOT NULL
      AND crm_pipeline_id IS NULL
      AND crm_customer_id IS NULL
    )
    OR (
      entity_type = 'crm_customer'
      AND workspace_organization_id IS NULL
      AND crm_pipeline_id IS NOT NULL
      AND crm_customer_id IS NOT NULL
      AND role = 'shipper'
    )
  ),
  CONSTRAINT operations_carrier_rate_parties_role_entity_valid CHECK (
    role = 'shipper' OR entity_type = 'workspace_organization'
  ),
  CONSTRAINT operations_carrier_rate_parties_name_present
    CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT operations_carrier_rate_parties_network_id_unique UNIQUE (network_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_carrier_rate_parties_platform
  ON operations_carrier_rate_parties (network_id)
  WHERE role = 'platform_operator';
CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_carrier_rate_parties_workspace
  ON operations_carrier_rate_parties (network_id, workspace_organization_id)
  WHERE workspace_organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_carrier_rate_parties_customer
  ON operations_carrier_rate_parties (network_id, crm_pipeline_id, crm_customer_id)
  WHERE crm_customer_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_operations_carrier_rate_party()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  platform_organization uuid;
BEGIN
  SELECT network.platform_organization_id
  INTO platform_organization
  FROM operations_carrier_rate_networks network
  WHERE network.id = NEW.network_id;

  IF NEW.role = 'platform_operator'
     AND NEW.workspace_organization_id IS DISTINCT FROM platform_organization THEN
    RAISE EXCEPTION 'Carrier rate network platform party must be the configured platform organization';
  END IF;

  IF NEW.role <> 'platform_operator'
     AND NEW.workspace_organization_id IS NOT NULL
     AND NEW.workspace_organization_id = platform_organization THEN
    RAISE EXCEPTION 'Platform organization cannot hold a second role in the same carrier rate network';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_carrier_rate_party_write
  ON operations_carrier_rate_parties;
CREATE TRIGGER validate_operations_carrier_rate_party_write
BEFORE INSERT OR UPDATE ON operations_carrier_rate_parties
FOR EACH ROW EXECUTE FUNCTION validate_operations_carrier_rate_party();

CREATE TABLE IF NOT EXISTS operations_carrier_account_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gca'),
  network_id uuid NOT NULL
    REFERENCES operations_carrier_rate_networks(id) ON DELETE RESTRICT,
  account_owner_organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  version_number integer NOT NULL DEFAULT 1 CHECK (version_number > 0),
  supersedes_authorization_id uuid,
  allow_rating boolean NOT NULL DEFAULT true,
  allow_labels boolean NOT NULL DEFAULT false,
  allow_tracking boolean NOT NULL DEFAULT true,
  allow_pickups boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  authorized_by text REFERENCES app_users(email) ON DELETE SET NULL,
  approved_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_account_authorizations_global_valid
    CHECK (global_id ~ '^gca[0-9]{7}$'),
  CONSTRAINT operations_carrier_account_authorizations_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_account_authorizations_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_account_authorizations_account_fkey
    FOREIGN KEY (account_owner_organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_account_authorizations_supersedes_fkey
    FOREIGN KEY (network_id, supersedes_authorization_id)
    REFERENCES operations_carrier_account_authorizations(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_account_authorizations_dates_valid
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT operations_carrier_account_authorizations_version_unique
    UNIQUE (network_id, integration_account_id, version_number),
  CONSTRAINT operations_carrier_account_authorizations_supersedes_unique
    UNIQUE (supersedes_authorization_id),
  CONSTRAINT operations_carrier_account_authorizations_network_id_unique
    UNIQUE (network_id, id),
  CONSTRAINT operations_carrier_account_authorizations_scope_unique
    UNIQUE (
      network_id, id, account_owner_organization_id, integration_account_id
    )
);

CREATE OR REPLACE FUNCTION validate_operations_carrier_account_authorization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_type text;
  owner_party_id uuid;
  superseded_owner_organization_id uuid;
  superseded_integration_account_id uuid;
  superseded_version_number integer;
BEGIN
  SELECT account.integration_type
  INTO account_type
  FROM operations_integration_accounts account
  WHERE account.organization_id = NEW.account_owner_organization_id
    AND account.id = NEW.integration_account_id;

  IF account_type IS DISTINCT FROM 'carrier' THEN
    RAISE EXCEPTION 'Carrier rate authorization requires a carrier integration account';
  END IF;

  SELECT party.id
  INTO owner_party_id
  FROM operations_carrier_rate_parties party
  WHERE party.network_id = NEW.network_id
    AND party.workspace_organization_id = NEW.account_owner_organization_id
    AND party.role IN ('platform_operator', 'reseller');

  IF owner_party_id IS NULL THEN
    RAISE EXCEPTION 'Carrier account owner must be a platform or reseller party in the rate network';
  END IF;

  IF NEW.version_number > 1 AND NEW.supersedes_authorization_id IS NULL THEN
    RAISE EXCEPTION 'Versioned carrier account authorization must identify the superseded version';
  END IF;
  IF NEW.version_number = 1 AND NEW.supersedes_authorization_id IS NOT NULL THEN
    RAISE EXCEPTION 'Initial carrier account authorization cannot supersede another version';
  END IF;

  IF NEW.supersedes_authorization_id IS NOT NULL THEN
    SELECT
      prior.account_owner_organization_id,
      prior.integration_account_id,
      prior.version_number
    INTO
      superseded_owner_organization_id,
      superseded_integration_account_id,
      superseded_version_number
    FROM operations_carrier_account_authorizations prior
    WHERE prior.network_id = NEW.network_id
      AND prior.id = NEW.supersedes_authorization_id;

    IF superseded_owner_organization_id IS DISTINCT FROM NEW.account_owner_organization_id
       OR superseded_integration_account_id IS DISTINCT FROM NEW.integration_account_id THEN
      RAISE EXCEPTION 'Carrier account authorization may only supersede the same carrier account';
    END IF;
    IF NEW.version_number IS DISTINCT FROM superseded_version_number + 1 THEN
      RAISE EXCEPTION 'Carrier account authorization versions must be sequential';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_carrier_account_authorization_write
  ON operations_carrier_account_authorizations;
CREATE TRIGGER validate_operations_carrier_account_authorization_write
BEFORE INSERT ON operations_carrier_account_authorizations
FOR EACH ROW EXECUTE FUNCTION validate_operations_carrier_account_authorization();

CREATE TABLE IF NOT EXISTS operations_carrier_rate_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('grg'),
  network_id uuid NOT NULL,
  account_authorization_id uuid NOT NULL,
  grantor_party_id uuid NOT NULL,
  grantee_party_id uuid NOT NULL,
  parent_grant_id uuid,
  version_number integer NOT NULL DEFAULT 1 CHECK (version_number > 0),
  supersedes_grant_id uuid,
  allow_rating boolean NOT NULL DEFAULT true,
  allow_labels boolean NOT NULL DEFAULT false,
  allow_tracking boolean NOT NULL DEFAULT true,
  allow_pickups boolean NOT NULL DEFAULT false,
  allow_regrant boolean NOT NULL DEFAULT false,
  all_grantee_users boolean NOT NULL DEFAULT false,
  max_descendant_depth integer NOT NULL DEFAULT 8
    CHECK (max_descendant_depth BETWEEN 0 AND 32),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  approved_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_rate_grants_global_valid
    CHECK (global_id ~ '^grg[0-9]{7}$'),
  CONSTRAINT operations_carrier_rate_grants_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_rate_grants_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_grants_authorization_fkey
    FOREIGN KEY (network_id, account_authorization_id)
    REFERENCES operations_carrier_account_authorizations(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_grants_grantor_fkey
    FOREIGN KEY (network_id, grantor_party_id)
    REFERENCES operations_carrier_rate_parties(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_grants_grantee_fkey
    FOREIGN KEY (network_id, grantee_party_id)
    REFERENCES operations_carrier_rate_parties(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_grants_parent_fkey
    FOREIGN KEY (network_id, parent_grant_id)
    REFERENCES operations_carrier_rate_grants(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_grants_supersedes_fkey
    FOREIGN KEY (network_id, supersedes_grant_id)
    REFERENCES operations_carrier_rate_grants(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_grants_parties_different
    CHECK (grantor_party_id <> grantee_party_id),
  CONSTRAINT operations_carrier_rate_grants_dates_valid
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT operations_carrier_rate_grants_version_unique
    UNIQUE (network_id, grantor_party_id, grantee_party_id, version_number),
  CONSTRAINT operations_carrier_rate_grants_supersedes_unique UNIQUE (supersedes_grant_id),
  CONSTRAINT operations_carrier_rate_grants_network_id_unique UNIQUE (network_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_carrier_rate_grants_active
  ON operations_carrier_rate_grants (
    network_id, account_authorization_id, grantor_party_id, grantee_party_id, effective_from DESC
  )
  WHERE status = 'active';

CREATE OR REPLACE FUNCTION validate_operations_carrier_rate_grant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  platform_party_id uuid;
  grantor_role text;
  grantee_role text;
  parent_grantee uuid;
  parent_authorization uuid;
  parent_allows_regrant boolean;
  parent_allows_rating boolean;
  parent_allows_labels boolean;
  parent_allows_tracking boolean;
  parent_allows_pickups boolean;
  parent_depth integer;
  parent_status text;
  authorization_status text;
  authorization_allows_rating boolean;
  authorization_allows_labels boolean;
  authorization_allows_tracking boolean;
  authorization_allows_pickups boolean;
  superseded_authorization uuid;
  superseded_grantor uuid;
  superseded_grantee uuid;
  superseded_parent uuid;
  superseded_version integer;
  path_has_cycle boolean;
BEGIN
  SELECT party.id
  INTO platform_party_id
  FROM operations_carrier_rate_parties party
  WHERE party.network_id = NEW.network_id
    AND party.role = 'platform_operator';

  IF platform_party_id IS NULL THEN
    RAISE EXCEPTION 'Carrier rate network requires a platform operator before grants are created';
  END IF;

  SELECT party.role INTO grantor_role
  FROM operations_carrier_rate_parties party
  WHERE party.network_id = NEW.network_id AND party.id = NEW.grantor_party_id;

  SELECT party.role INTO grantee_role
  FROM operations_carrier_rate_parties party
  WHERE party.network_id = NEW.network_id AND party.id = NEW.grantee_party_id;

  IF grantor_role NOT IN ('platform_operator', 'reseller')
     OR grantee_role NOT IN ('reseller', 'shipper') THEN
    RAISE EXCEPTION 'Carrier rate grants must follow platform operator to reseller to shipper roles';
  END IF;

  SELECT
    account_authorization.status,
    account_authorization.allow_rating,
    account_authorization.allow_labels,
    account_authorization.allow_tracking,
    account_authorization.allow_pickups
  INTO
    authorization_status,
    authorization_allows_rating,
    authorization_allows_labels,
    authorization_allows_tracking,
    authorization_allows_pickups
  FROM operations_carrier_account_authorizations account_authorization
  WHERE account_authorization.network_id = NEW.network_id
    AND account_authorization.id = NEW.account_authorization_id;

  IF authorization_status IS DISTINCT FROM 'active' AND NEW.status = 'active' THEN
    RAISE EXCEPTION 'Active carrier rate grant requires an active carrier account authorization';
  END IF;
  IF (NEW.allow_rating AND authorization_allows_rating IS DISTINCT FROM true)
     OR (NEW.allow_labels AND authorization_allows_labels IS DISTINCT FROM true)
     OR (NEW.allow_tracking AND authorization_allows_tracking IS DISTINCT FROM true)
     OR (NEW.allow_pickups AND authorization_allows_pickups IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'Carrier rate grant cannot exceed its account authorization capabilities';
  END IF;

  IF NEW.parent_grant_id IS NULL THEN
    IF NEW.grantor_party_id <> platform_party_id THEN
      RAISE EXCEPTION 'Root carrier rate grant must begin with the platform operator';
    END IF;
  ELSE
    SELECT
      parent.grantee_party_id,
      parent.account_authorization_id,
      parent.allow_regrant,
      parent.allow_rating,
      parent.allow_labels,
      parent.allow_tracking,
      parent.allow_pickups,
      parent.max_descendant_depth,
      parent.status
    INTO
      parent_grantee,
      parent_authorization,
      parent_allows_regrant,
      parent_allows_rating,
      parent_allows_labels,
      parent_allows_tracking,
      parent_allows_pickups,
      parent_depth,
      parent_status
    FROM operations_carrier_rate_grants parent
    WHERE parent.network_id = NEW.network_id
      AND parent.id = NEW.parent_grant_id;

    IF parent_grantee IS DISTINCT FROM NEW.grantor_party_id
       OR parent_authorization IS DISTINCT FROM NEW.account_authorization_id THEN
      RAISE EXCEPTION 'Carrier rate grant must continue its parent grant path and account authorization';
    END IF;
    IF parent_status IS DISTINCT FROM 'active'
       OR parent_allows_regrant IS DISTINCT FROM true
       OR parent_depth < 1 THEN
      RAISE EXCEPTION 'Parent carrier rate grant does not permit regranting';
    END IF;
    IF NEW.max_descendant_depth >= parent_depth THEN
      RAISE EXCEPTION 'Child carrier rate grant must reduce the remaining regrant depth';
    END IF;
    IF (NEW.allow_rating AND parent_allows_rating IS DISTINCT FROM true)
       OR (NEW.allow_labels AND parent_allows_labels IS DISTINCT FROM true)
       OR (NEW.allow_tracking AND parent_allows_tracking IS DISTINCT FROM true)
       OR (NEW.allow_pickups AND parent_allows_pickups IS DISTINCT FROM true) THEN
      RAISE EXCEPTION 'Child carrier rate grant cannot exceed its parent grant capabilities';
    END IF;

    WITH RECURSIVE ancestors AS (
      SELECT parent.id, parent.parent_grant_id, parent.grantor_party_id, parent.grantee_party_id
      FROM operations_carrier_rate_grants parent
      WHERE parent.network_id = NEW.network_id AND parent.id = NEW.parent_grant_id
      UNION ALL
      SELECT parent.id, parent.parent_grant_id, parent.grantor_party_id, parent.grantee_party_id
      FROM operations_carrier_rate_grants parent
      JOIN ancestors child ON child.parent_grant_id = parent.id
      WHERE parent.network_id = NEW.network_id
    )
    SELECT EXISTS (
      SELECT 1
      FROM ancestors
      WHERE grantor_party_id = NEW.grantee_party_id
         OR grantee_party_id = NEW.grantee_party_id
    )
    INTO path_has_cycle;

    IF path_has_cycle THEN
      RAISE EXCEPTION 'Carrier rate grant would create a cycle';
    END IF;
  END IF;

  IF NEW.version_number > 1 AND NEW.supersedes_grant_id IS NULL THEN
    RAISE EXCEPTION 'Versioned carrier rate grant must identify the superseded version';
  END IF;
  IF NEW.version_number = 1 AND NEW.supersedes_grant_id IS NOT NULL THEN
    RAISE EXCEPTION 'Initial carrier rate grant cannot supersede another version';
  END IF;

  IF NEW.supersedes_grant_id IS NOT NULL THEN
    SELECT
      prior.account_authorization_id,
      prior.grantor_party_id,
      prior.grantee_party_id,
      prior.parent_grant_id,
      prior.version_number
    INTO
      superseded_authorization,
      superseded_grantor,
      superseded_grantee,
      superseded_parent,
      superseded_version
    FROM operations_carrier_rate_grants prior
    WHERE prior.network_id = NEW.network_id
      AND prior.id = NEW.supersedes_grant_id;

    IF superseded_authorization IS DISTINCT FROM NEW.account_authorization_id
       OR superseded_grantor IS DISTINCT FROM NEW.grantor_party_id
       OR superseded_grantee IS DISTINCT FROM NEW.grantee_party_id
       OR superseded_parent IS DISTINCT FROM NEW.parent_grant_id THEN
      RAISE EXCEPTION 'Carrier rate grant may only supersede the same grant path';
    END IF;
    IF NEW.version_number IS DISTINCT FROM superseded_version + 1 THEN
      RAISE EXCEPTION 'Carrier rate grant versions must be sequential';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_carrier_rate_grant_write
  ON operations_carrier_rate_grants;
CREATE TRIGGER validate_operations_carrier_rate_grant_write
BEFORE INSERT ON operations_carrier_rate_grants
FOR EACH ROW EXECUTE FUNCTION validate_operations_carrier_rate_grant();

CREATE TABLE IF NOT EXISTS operations_carrier_rate_grant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gru'),
  network_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  workspace_organization_id uuid NOT NULL,
  user_email text NOT NULL,
  version_number integer NOT NULL DEFAULT 1 CHECK (version_number > 0),
  supersedes_grant_user_id uuid,
  status text NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'revoked')),
  can_create_shipments boolean NOT NULL DEFAULT true,
  can_view_cost boolean NOT NULL DEFAULT false,
  can_schedule_pickups boolean NOT NULL DEFAULT false,
  granted_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_rate_grant_users_global_valid
    CHECK (global_id ~ '^gru[0-9]{7}$'),
  CONSTRAINT operations_carrier_rate_grant_users_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_rate_grant_users_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_grant_users_grant_fkey
    FOREIGN KEY (network_id, grant_id)
    REFERENCES operations_carrier_rate_grants(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_grant_users_membership_fkey
    FOREIGN KEY (user_email, workspace_organization_id)
    REFERENCES app_user_organization_memberships(user_email, organization_id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_grant_users_supersedes_fkey
    FOREIGN KEY (supersedes_grant_user_id)
    REFERENCES operations_carrier_rate_grant_users(id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_grant_users_version_unique
    UNIQUE (grant_id, user_email, version_number),
  CONSTRAINT operations_carrier_rate_grant_users_supersedes_unique
    UNIQUE (supersedes_grant_user_id)
);

CREATE OR REPLACE FUNCTION validate_operations_carrier_rate_grant_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  grant_allows_labels boolean;
  grant_allows_pickups boolean;
  grant_allows_rating boolean;
  prior_grant_id uuid;
  prior_workspace_organization_id uuid;
  prior_user_email text;
  prior_version_number integer;
BEGIN
  SELECT
    rate_grant.allow_labels,
    rate_grant.allow_pickups,
    rate_grant.allow_rating
  INTO
    grant_allows_labels,
    grant_allows_pickups,
    grant_allows_rating
  FROM operations_carrier_rate_grants rate_grant
  WHERE rate_grant.network_id = NEW.network_id
    AND rate_grant.id = NEW.grant_id;

  IF NEW.status = 'granted'
     AND NEW.can_create_shipments
     AND (
       grant_allows_rating IS DISTINCT FROM true
       OR grant_allows_labels IS DISTINCT FROM true
     ) THEN
    RAISE EXCEPTION 'Shipment permission requires rating and label capabilities on the carrier rate grant';
  END IF;
  IF NEW.status = 'granted'
     AND NEW.can_schedule_pickups
     AND grant_allows_pickups IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Pickup permission exceeds the carrier rate grant capability';
  END IF;

  IF NEW.version_number > 1 AND NEW.supersedes_grant_user_id IS NULL THEN
    RAISE EXCEPTION 'Versioned carrier rate user grant must identify the superseded version';
  END IF;
  IF NEW.version_number = 1 AND NEW.supersedes_grant_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'Initial carrier rate user grant cannot supersede another version';
  END IF;

  IF NEW.supersedes_grant_user_id IS NOT NULL THEN
    SELECT
      prior.grant_id,
      prior.workspace_organization_id,
      prior.user_email,
      prior.version_number
    INTO
      prior_grant_id,
      prior_workspace_organization_id,
      prior_user_email,
      prior_version_number
    FROM operations_carrier_rate_grant_users prior
    WHERE prior.id = NEW.supersedes_grant_user_id;

    IF prior_grant_id IS DISTINCT FROM NEW.grant_id
       OR prior_workspace_organization_id IS DISTINCT FROM NEW.workspace_organization_id
       OR lower(prior_user_email) IS DISTINCT FROM lower(NEW.user_email) THEN
      RAISE EXCEPTION 'Carrier rate user grant may only supersede the same user and grant';
    END IF;
    IF NEW.version_number IS DISTINCT FROM prior_version_number + 1 THEN
      RAISE EXCEPTION 'Carrier rate user grant versions must be sequential';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_carrier_rate_grant_user_write
  ON operations_carrier_rate_grant_users;
CREATE TRIGGER validate_operations_carrier_rate_grant_user_write
BEFORE INSERT ON operations_carrier_rate_grant_users
FOR EACH ROW EXECUTE FUNCTION validate_operations_carrier_rate_grant_user();

CREATE TABLE IF NOT EXISTS operations_carrier_rate_directives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('grd'),
  network_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  beneficiary_party_id uuid NOT NULL,
  version_number integer NOT NULL DEFAULT 1 CHECK (version_number > 0),
  supersedes_directive_id uuid,
  directive_type text NOT NULL CHECK (directive_type IN (
    'fixed_amount', 'percent_markup', 'cost_plus_percent',
    'minimum_charge', 'maximum_charge'
  )),
  calculation_basis text NOT NULL DEFAULT 'quoted_cost'
    CHECK (calculation_basis IN ('quoted_cost', 'actual_cost')),
  amount_minor bigint,
  basis_points integer,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  priority integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  contract_version_id uuid,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  approved_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_rate_directives_global_valid
    CHECK (global_id ~ '^grd[0-9]{7}$'),
  CONSTRAINT operations_carrier_rate_directives_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_rate_directives_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_directives_grant_fkey
    FOREIGN KEY (network_id, grant_id)
    REFERENCES operations_carrier_rate_grants(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_directives_beneficiary_fkey
    FOREIGN KEY (network_id, beneficiary_party_id)
    REFERENCES operations_carrier_rate_parties(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_directives_contract_version_fkey
    FOREIGN KEY (contract_version_id)
    REFERENCES operations_contract_versions(id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_directives_supersedes_fkey
    FOREIGN KEY (network_id, supersedes_directive_id)
    REFERENCES operations_carrier_rate_directives(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_directives_values_valid CHECK (
    (
      directive_type IN ('fixed_amount', 'minimum_charge', 'maximum_charge')
      AND amount_minor IS NOT NULL
      AND amount_minor >= 0
      AND basis_points IS NULL
    )
    OR (
      directive_type IN ('percent_markup', 'cost_plus_percent')
      AND basis_points IS NOT NULL
      AND basis_points BETWEEN 0 AND 100000
      AND amount_minor IS NULL
    )
  ),
  CONSTRAINT operations_carrier_rate_directives_dates_valid
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT operations_carrier_rate_directives_version_unique
    UNIQUE (grant_id, priority, version_number),
  CONSTRAINT operations_carrier_rate_directives_supersedes_unique
    UNIQUE (supersedes_directive_id),
  CONSTRAINT operations_carrier_rate_directives_network_id_unique UNIQUE (network_id, id)
);

CREATE OR REPLACE FUNCTION validate_operations_carrier_rate_directive()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  grantor_party uuid;
  prior_grant_id uuid;
  prior_priority integer;
  prior_version_number integer;
BEGIN
  SELECT rate_grant.grantor_party_id
  INTO grantor_party
  FROM operations_carrier_rate_grants rate_grant
  WHERE rate_grant.network_id = NEW.network_id
    AND rate_grant.id = NEW.grant_id;

  IF grantor_party IS DISTINCT FROM NEW.beneficiary_party_id THEN
    RAISE EXCEPTION 'Carrier rate directive beneficiary must be the grantor party';
  END IF;

  IF NEW.version_number > 1 AND NEW.supersedes_directive_id IS NULL THEN
    RAISE EXCEPTION 'Versioned carrier rate directive must identify the superseded version';
  END IF;
  IF NEW.version_number = 1 AND NEW.supersedes_directive_id IS NOT NULL THEN
    RAISE EXCEPTION 'Initial carrier rate directive cannot supersede another version';
  END IF;

  IF NEW.supersedes_directive_id IS NOT NULL THEN
    SELECT prior.grant_id, prior.priority, prior.version_number
    INTO prior_grant_id, prior_priority, prior_version_number
    FROM operations_carrier_rate_directives prior
    WHERE prior.network_id = NEW.network_id
      AND prior.id = NEW.supersedes_directive_id;

    IF prior_grant_id IS DISTINCT FROM NEW.grant_id
       OR prior_priority IS DISTINCT FROM NEW.priority THEN
      RAISE EXCEPTION 'Carrier rate directive may only supersede the same grant and priority';
    END IF;
    IF NEW.version_number IS DISTINCT FROM prior_version_number + 1 THEN
      RAISE EXCEPTION 'Carrier rate directive versions must be sequential';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_carrier_rate_directive_write
  ON operations_carrier_rate_directives;
CREATE TRIGGER validate_operations_carrier_rate_directive_write
BEFORE INSERT ON operations_carrier_rate_directives
FOR EACH ROW EXECUTE FUNCTION validate_operations_carrier_rate_directive();

CREATE TABLE IF NOT EXISTS operations_carrier_quote_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gqs'),
  executing_organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  network_id uuid NOT NULL
    REFERENCES operations_carrier_rate_networks(id) ON DELETE RESTRICT,
  account_authorization_id uuid NOT NULL,
  account_owner_organization_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  order_id uuid,
  package_id uuid,
  shipper_party_id uuid NOT NULL,
  carrier_rate_id uuid,
  carrier_rate_request_id uuid,
  platform_directive_id uuid NOT NULL,
  carrier text NOT NULL,
  service_code text NOT NULL,
  provider_quote_id text,
  quoted_carrier_cost_minor bigint NOT NULL CHECK (quoted_carrier_cost_minor >= 0),
  customer_charge_minor bigint NOT NULL CHECK (customer_charge_minor >= 0),
  platform_fee_minor bigint NOT NULL CHECK (platform_fee_minor >= 0),
  reseller_fee_minor bigint NOT NULL DEFAULT 0 CHECK (reseller_fee_minor >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  party_path_snapshot jsonb NOT NULL,
  grant_path_snapshot jsonb NOT NULL,
  directive_snapshot jsonb NOT NULL,
  pricing_snapshot jsonb NOT NULL,
  redacted_provider_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  quoted_at timestamptz NOT NULL,
  expires_at timestamptz,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_quote_snapshots_global_valid
    CHECK (global_id ~ '^gqs[0-9]{7}$'),
  CONSTRAINT operations_carrier_quote_snapshots_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_quote_snapshots_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_quote_snapshots_authorization_fkey
    FOREIGN KEY (
      network_id, account_authorization_id,
      account_owner_organization_id, integration_account_id
    )
    REFERENCES operations_carrier_account_authorizations(
      network_id, id, account_owner_organization_id, integration_account_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_quote_snapshots_order_fkey
    FOREIGN KEY (executing_organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_quote_snapshots_package_fkey
    FOREIGN KEY (executing_organization_id, package_id)
    REFERENCES operations_packages(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_quote_snapshots_shipper_fkey
    FOREIGN KEY (network_id, shipper_party_id)
    REFERENCES operations_carrier_rate_parties(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_quote_snapshots_rate_fkey
    FOREIGN KEY (executing_organization_id, carrier_rate_id)
    REFERENCES operations_carrier_rates(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_quote_snapshots_rate_request_fkey
    FOREIGN KEY (carrier_rate_request_id)
    REFERENCES operations_carrier_rate_requests(id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_quote_snapshots_directive_fkey
    FOREIGN KEY (network_id, platform_directive_id)
    REFERENCES operations_carrier_rate_directives(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_quote_snapshots_amounts_valid CHECK (
    customer_charge_minor
      = quoted_carrier_cost_minor + platform_fee_minor + reseller_fee_minor
  ),
  CONSTRAINT operations_carrier_quote_snapshots_path_valid CHECK (
    jsonb_typeof(party_path_snapshot) = 'array'
    AND jsonb_array_length(party_path_snapshot) >= 2
    AND jsonb_typeof(grant_path_snapshot) = 'array'
    AND jsonb_array_length(grant_path_snapshot) >= 1
    AND jsonb_typeof(directive_snapshot) = 'array'
    AND jsonb_array_length(directive_snapshot) >= 1
    AND pricing_snapshot ? 'platformFee'
  ),
  CONSTRAINT operations_carrier_quote_snapshots_dates_valid
    CHECK (expires_at IS NULL OR expires_at > quoted_at),
  CONSTRAINT operations_carrier_quote_snapshots_idempotency_unique
    UNIQUE (executing_organization_id, idempotency_key),
  CONSTRAINT operations_carrier_quote_snapshots_org_id_unique
    UNIQUE (executing_organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_carrier_quote_snapshots_shipment_lookup
  ON operations_carrier_quote_snapshots (
    executing_organization_id, carrier, provider_quote_id, quoted_at DESC
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'operations_shipments'
      AND column_name = 'actual_carrier_cost_minor'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'operations_shipments'
      AND column_name = 'quoted_carrier_cost_minor'
  ) THEN
    ALTER TABLE operations_shipments
      RENAME COLUMN actual_carrier_cost_minor TO quoted_carrier_cost_minor;
  END IF;
END;
$$;

ALTER TABLE operations_shipments
  ADD COLUMN IF NOT EXISTS rate_quote_snapshot_id uuid,
  ADD COLUMN IF NOT EXISTS carrier_cost_status text NOT NULL DEFAULT 'quoted'
    CHECK (carrier_cost_status IN ('quoted', 'provisional', 'reconciled', 'adjusted'));

ALTER TABLE operations_shipments
  DROP CONSTRAINT IF EXISTS operations_shipments_quote_snapshot_fkey,
  ADD CONSTRAINT operations_shipments_quote_snapshot_fkey
    FOREIGN KEY (organization_id, rate_quote_snapshot_id)
    REFERENCES operations_carrier_quote_snapshots(executing_organization_id, id) ON DELETE RESTRICT;

COMMENT ON COLUMN operations_shipments.quoted_carrier_cost_minor IS
  'Pro forma carrier cost captured at label or shipment time. Actual carrier cost is derived from carrier billing reconciliation.';

CREATE TABLE IF NOT EXISTS operations_settlement_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gse'),
  network_id uuid NOT NULL
    REFERENCES operations_carrier_rate_networks(id) ON DELETE RESTRICT,
  quote_snapshot_id uuid NOT NULL
    REFERENCES operations_carrier_quote_snapshots(id) ON DELETE RESTRICT,
  executing_organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  shipment_id uuid,
  settlement_type text NOT NULL CHECK (settlement_type IN (
    'carrier_payable', 'carrier_cost_reimbursement',
    'platform_fee', 'reseller_fee', 'credit', 'rebill', 'payout'
  )),
  payer_type text NOT NULL CHECK (payer_type IN ('rate_party', 'carrier')),
  payer_party_id uuid,
  payer_external_ref text,
  payee_type text NOT NULL CHECK (payee_type IN ('rate_party', 'carrier')),
  payee_party_id uuid,
  payee_external_ref text,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  initial_status text NOT NULL DEFAULT 'accrued'
    CHECK (initial_status IN ('accrued', 'approved')),
  source_type text NOT NULL CHECK (source_type IN (
    'quote_snapshot', 'carrier_reconciliation', 'manual_adjustment'
  )),
  source_global_id text NOT NULL,
  reverses_entry_id uuid,
  directive_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  calculation_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_settlement_entries_global_valid
    CHECK (global_id ~ '^gse[0-9]{7}$'),
  CONSTRAINT operations_settlement_entries_global_unique UNIQUE (global_id),
  CONSTRAINT operations_settlement_entries_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_settlement_entries_shipment_fkey
    FOREIGN KEY (executing_organization_id, shipment_id)
    REFERENCES operations_shipments(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_settlement_entries_payer_party_fkey
    FOREIGN KEY (network_id, payer_party_id)
    REFERENCES operations_carrier_rate_parties(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_settlement_entries_payee_party_fkey
    FOREIGN KEY (network_id, payee_party_id)
    REFERENCES operations_carrier_rate_parties(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_settlement_entries_reverses_fkey
    FOREIGN KEY (reverses_entry_id)
    REFERENCES operations_settlement_entries(id) ON DELETE RESTRICT,
  CONSTRAINT operations_settlement_entries_payer_valid CHECK (
    (payer_type = 'rate_party' AND payer_party_id IS NOT NULL AND payer_external_ref IS NULL)
    OR (
      payer_type = 'carrier'
      AND payer_party_id IS NULL
      AND NULLIF(btrim(payer_external_ref), '') IS NOT NULL
    )
  ),
  CONSTRAINT operations_settlement_entries_payee_valid CHECK (
    (payee_type = 'rate_party' AND payee_party_id IS NOT NULL AND payee_external_ref IS NULL)
    OR (
      payee_type = 'carrier'
      AND payee_party_id IS NULL
      AND NULLIF(btrim(payee_external_ref), '') IS NOT NULL
    )
  ),
  CONSTRAINT operations_settlement_entries_reversal_valid CHECK (
    settlement_type IN ('credit', 'rebill') OR reverses_entry_id IS NULL
  ),
  CONSTRAINT operations_settlement_entries_idempotency_unique
    UNIQUE (network_id, idempotency_key),
  CONSTRAINT operations_settlement_entries_reversal_unique UNIQUE (reverses_entry_id),
  CONSTRAINT operations_settlement_entries_network_id_unique UNIQUE (network_id, id)
);

CREATE TABLE IF NOT EXISTS operations_settlement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gsv'),
  network_id uuid NOT NULL,
  settlement_entry_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'approved', 'billed', 'paid', 'disputed', 'resolved', 'reversed', 'voided'
  )),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_settlement_events_global_valid CHECK (global_id ~ '^gsv[0-9]{7}$'),
  CONSTRAINT operations_settlement_events_global_unique UNIQUE (global_id),
  CONSTRAINT operations_settlement_events_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_settlement_events_entry_fkey
    FOREIGN KEY (network_id, settlement_entry_id)
    REFERENCES operations_settlement_entries(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_settlement_events_idempotency_unique
    UNIQUE (network_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS operations_carrier_billing_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcb'),
  network_id uuid NOT NULL
    REFERENCES operations_carrier_rate_networks(id) ON DELETE RESTRICT,
  importing_organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  source_format text NOT NULL CHECK (source_format IN ('csv', 'xlsx', 'xml', 'edi', 'pdf', 'api')),
  source_filename text NOT NULL,
  source_checksum text NOT NULL CHECK (source_checksum ~ '^[a-f0-9]{64}$'),
  source_document_id uuid REFERENCES app_documents(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processing', 'completed', 'failed')),
  imported_row_count integer NOT NULL DEFAULT 0 CHECK (imported_row_count >= 0),
  rejected_row_count integer NOT NULL DEFAULT 0 CHECK (rejected_row_count >= 0),
  error_summary text,
  imported_by text REFERENCES app_users(email) ON DELETE SET NULL,
  service_actor text,
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_billing_batches_global_valid
    CHECK (global_id ~ '^gcb[0-9]{7}$'),
  CONSTRAINT operations_carrier_billing_batches_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_billing_batches_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_batches_provider_present
    CHECK (NULLIF(btrim(provider), '') IS NOT NULL),
  CONSTRAINT operations_carrier_billing_batches_filename_present
    CHECK (NULLIF(btrim(source_filename), '') IS NOT NULL),
  CONSTRAINT operations_carrier_billing_batches_actor_valid CHECK (
    imported_by IS NOT NULL OR NULLIF(btrim(service_actor), '') IS NOT NULL
  ),
  CONSTRAINT operations_carrier_billing_batches_dates_valid CHECK (
    completed_at IS NULL OR completed_at >= received_at
  ),
  CONSTRAINT operations_carrier_billing_batches_source_unique
    UNIQUE (network_id, provider, environment, source_checksum),
  CONSTRAINT operations_carrier_billing_batches_network_id_unique
    UNIQUE (network_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_carrier_billing_batches_status
  ON operations_carrier_billing_batches (
    network_id, provider, environment, status, received_at DESC
  );

CREATE TABLE IF NOT EXISTS operations_carrier_billing_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcs'),
  network_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  external_statement_id text NOT NULL,
  billed_account_masked_reference text NOT NULL,
  billed_account_fingerprint text NOT NULL
    CHECK (billed_account_fingerprint ~ '^[a-f0-9]{64}$'),
  version_number integer NOT NULL DEFAULT 1 CHECK (version_number > 0),
  supersedes_statement_id uuid,
  statement_period_start date,
  statement_period_end date,
  issued_at timestamptz,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  statement_total_minor bigint,
  finalized boolean NOT NULL DEFAULT false,
  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_billing_statements_global_valid
    CHECK (global_id ~ '^gcs[0-9]{7}$'),
  CONSTRAINT operations_carrier_billing_statements_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_billing_statements_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_statements_batch_fkey
    FOREIGN KEY (network_id, batch_id)
    REFERENCES operations_carrier_billing_batches(network_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_statements_supersedes_fkey
    FOREIGN KEY (network_id, supersedes_statement_id)
    REFERENCES operations_carrier_billing_statements(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_statements_external_present
    CHECK (NULLIF(btrim(external_statement_id), '') IS NOT NULL),
  CONSTRAINT operations_carrier_billing_statements_masked_account_present
    CHECK (NULLIF(btrim(billed_account_masked_reference), '') IS NOT NULL),
  CONSTRAINT operations_carrier_billing_statements_period_valid CHECK (
    statement_period_end IS NULL
    OR statement_period_start IS NULL
    OR statement_period_end >= statement_period_start
  ),
  CONSTRAINT operations_carrier_billing_statements_version_unique
    UNIQUE (
      network_id, billed_account_fingerprint, external_statement_id, version_number
    ),
  CONSTRAINT operations_carrier_billing_statements_supersedes_unique
    UNIQUE (supersedes_statement_id),
  CONSTRAINT operations_carrier_billing_statements_network_id_unique
    UNIQUE (network_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_carrier_billing_statements_account
  ON operations_carrier_billing_statements (
    network_id, billed_account_fingerprint, issued_at DESC, id
  );

CREATE OR REPLACE FUNCTION validate_operations_carrier_billing_statement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_account_fingerprint text;
  prior_external_statement_id text;
  prior_version_number integer;
BEGIN
  IF NEW.version_number > 1 AND NEW.supersedes_statement_id IS NULL THEN
    RAISE EXCEPTION 'Versioned carrier billing statement must identify the superseded version';
  END IF;
  IF NEW.version_number = 1 AND NEW.supersedes_statement_id IS NOT NULL THEN
    RAISE EXCEPTION 'Initial carrier billing statement cannot supersede another version';
  END IF;

  IF NEW.supersedes_statement_id IS NOT NULL THEN
    SELECT
      prior.billed_account_fingerprint,
      prior.external_statement_id,
      prior.version_number
    INTO
      prior_account_fingerprint,
      prior_external_statement_id,
      prior_version_number
    FROM operations_carrier_billing_statements prior
    WHERE prior.network_id = NEW.network_id
      AND prior.id = NEW.supersedes_statement_id;

    IF prior_account_fingerprint IS DISTINCT FROM NEW.billed_account_fingerprint
       OR prior_external_statement_id IS DISTINCT FROM NEW.external_statement_id THEN
      RAISE EXCEPTION 'Carrier billing statement may only supersede the same external statement and account';
    END IF;
    IF NEW.version_number IS DISTINCT FROM prior_version_number + 1 THEN
      RAISE EXCEPTION 'Carrier billing statement versions must be sequential';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_carrier_billing_statement_write
  ON operations_carrier_billing_statements;
CREATE TRIGGER validate_operations_carrier_billing_statement_write
BEFORE INSERT ON operations_carrier_billing_statements
FOR EACH ROW EXECUTE FUNCTION validate_operations_carrier_billing_statement();

CREATE TABLE IF NOT EXISTS operations_carrier_billing_account_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gba'),
  network_id uuid NOT NULL,
  statement_id uuid NOT NULL,
  decision text NOT NULL
    CHECK (decision IN ('matched', 'unmatched', 'ambiguous', 'rejected')),
  account_authorization_id uuid,
  account_owner_organization_id uuid,
  integration_account_id uuid,
  supersedes_resolution_id uuid,
  match_method text NOT NULL
    CHECK (match_method IN ('account_fingerprint', 'manual', 'none')),
  confidence_basis_points integer NOT NULL DEFAULT 0
    CHECK (confidence_basis_points BETWEEN 0 AND 10000),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidate_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text,
  decided_by text REFERENCES app_users(email) ON DELETE SET NULL,
  service_actor text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_billing_account_resolutions_global_valid
    CHECK (global_id ~ '^gba[0-9]{7}$'),
  CONSTRAINT operations_carrier_billing_account_resolutions_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_billing_account_resolutions_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_account_resolutions_statement_fkey
    FOREIGN KEY (network_id, statement_id)
    REFERENCES operations_carrier_billing_statements(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_account_resolutions_authorization_fkey
    FOREIGN KEY (
      network_id, account_authorization_id,
      account_owner_organization_id, integration_account_id
    )
    REFERENCES operations_carrier_account_authorizations(
      network_id, id, account_owner_organization_id, integration_account_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_account_resolutions_supersedes_fkey
    FOREIGN KEY (network_id, supersedes_resolution_id)
    REFERENCES operations_carrier_billing_account_resolutions(network_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_account_resolutions_target_valid CHECK (
    (
      decision = 'matched'
      AND account_authorization_id IS NOT NULL
      AND account_owner_organization_id IS NOT NULL
      AND integration_account_id IS NOT NULL
      AND match_method <> 'none'
    )
    OR (
      decision <> 'matched'
      AND account_authorization_id IS NULL
      AND account_owner_organization_id IS NULL
      AND integration_account_id IS NULL
    )
  ),
  CONSTRAINT operations_carrier_billing_account_resolutions_actor_valid CHECK (
    decided_by IS NOT NULL OR NULLIF(btrim(service_actor), '') IS NOT NULL
  ),
  CONSTRAINT operations_carrier_billing_account_resolutions_supersedes_unique
    UNIQUE (supersedes_resolution_id),
  CONSTRAINT operations_carrier_billing_account_resolutions_network_id_unique
    UNIQUE (network_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_carrier_billing_account_resolutions_statement
  ON operations_carrier_billing_account_resolutions (
    network_id, statement_id, decided_at DESC, id
  );

CREATE OR REPLACE FUNCTION validate_operations_carrier_billing_account_resolution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_statement_id uuid;
BEGIN
  IF NEW.supersedes_resolution_id IS NOT NULL THEN
    SELECT prior.statement_id
    INTO prior_statement_id
    FROM operations_carrier_billing_account_resolutions prior
    WHERE prior.network_id = NEW.network_id
      AND prior.id = NEW.supersedes_resolution_id;

    IF prior_statement_id IS DISTINCT FROM NEW.statement_id THEN
      RAISE EXCEPTION 'Carrier billing account resolution may only supersede a decision for the same statement';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_carrier_billing_account_resolution_write
  ON operations_carrier_billing_account_resolutions;
CREATE TRIGGER validate_operations_carrier_billing_account_resolution_write
BEFORE INSERT ON operations_carrier_billing_account_resolutions
FOR EACH ROW EXECUTE FUNCTION validate_operations_carrier_billing_account_resolution();

CREATE OR REPLACE VIEW operations_carrier_billing_current_account_resolutions AS
SELECT DISTINCT ON (resolution.statement_id)
  resolution.*
FROM operations_carrier_billing_account_resolutions resolution
ORDER BY resolution.statement_id, resolution.decided_at DESC, resolution.id DESC;

CREATE TABLE IF NOT EXISTS operations_carrier_billing_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcl'),
  network_id uuid NOT NULL,
  statement_id uuid NOT NULL,
  external_charge_id text NOT NULL,
  source_row_hash text NOT NULL CHECK (source_row_hash ~ '^[a-f0-9]{64}$'),
  tracking_number text,
  provider_label_id text,
  package_reference text,
  service_code text,
  charge_category text NOT NULL CHECK (charge_category IN (
    'transportation', 'fuel_surcharge', 'residential_surcharge',
    'delivery_area_surcharge', 'address_correction', 'dimensional_adjustment',
    'weight_adjustment', 'signature', 'saturday', 'declared_value',
    'tax', 'duty', 'late_fee', 'refund', 'credit', 'other'
  )),
  description text,
  amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  shipment_date date,
  billed_at timestamptz,
  line_sequence integer NOT NULL CHECK (line_sequence > 0),
  sender_address_fingerprint text
    CHECK (sender_address_fingerprint IS NULL OR sender_address_fingerprint ~ '^[a-f0-9]{64}$'),
  recipient_address_fingerprint text
    CHECK (recipient_address_fingerprint IS NULL OR recipient_address_fingerprint ~ '^[a-f0-9]{64}$'),
  routing_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_billing_charges_global_valid
    CHECK (global_id ~ '^gcl[0-9]{7}$'),
  CONSTRAINT operations_carrier_billing_charges_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_billing_charges_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_charges_statement_fkey
    FOREIGN KEY (network_id, statement_id)
    REFERENCES operations_carrier_billing_statements(network_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_charges_external_present
    CHECK (NULLIF(btrim(external_charge_id), '') IS NOT NULL),
  CONSTRAINT operations_carrier_billing_charges_tracking_present
    CHECK (tracking_number IS NULL OR NULLIF(btrim(tracking_number), '') IS NOT NULL),
  CONSTRAINT operations_carrier_billing_charges_routing_attributes_valid
    CHECK (jsonb_typeof(routing_attributes) = 'object'),
  CONSTRAINT operations_carrier_billing_charges_external_unique
    UNIQUE (statement_id, external_charge_id),
  CONSTRAINT operations_carrier_billing_charges_source_row_unique
    UNIQUE (statement_id, source_row_hash),
  CONSTRAINT operations_carrier_billing_charges_sequence_unique
    UNIQUE (statement_id, line_sequence),
  CONSTRAINT operations_carrier_billing_charges_network_id_unique
    UNIQUE (network_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_carrier_billing_charges_tracking
  ON operations_carrier_billing_charges (
    network_id, tracking_number, billed_at DESC
  )
  WHERE tracking_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS operations_carrier_billing_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcm'),
  network_id uuid NOT NULL,
  charge_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('matched', 'unmatched', 'ambiguous', 'rejected')),
  executing_organization_id uuid
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  shipment_id uuid,
  package_id uuid,
  label_id uuid,
  supersedes_match_id uuid,
  match_method text NOT NULL CHECK (match_method IN (
    'tracking_number', 'provider_label_id', 'shipment_reference',
    'amount_and_date', 'manual', 'none'
  )),
  confidence_basis_points integer NOT NULL DEFAULT 0
    CHECK (confidence_basis_points BETWEEN 0 AND 10000),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidate_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text,
  decided_by text REFERENCES app_users(email) ON DELETE SET NULL,
  service_actor text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_billing_matches_global_valid
    CHECK (global_id ~ '^gcm[0-9]{7}$'),
  CONSTRAINT operations_carrier_billing_matches_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_billing_matches_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_matches_charge_fkey
    FOREIGN KEY (network_id, charge_id)
    REFERENCES operations_carrier_billing_charges(network_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_matches_shipment_fkey
    FOREIGN KEY (executing_organization_id, shipment_id)
    REFERENCES operations_shipments(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_matches_package_fkey
    FOREIGN KEY (executing_organization_id, package_id)
    REFERENCES operations_packages(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_matches_label_fkey
    FOREIGN KEY (executing_organization_id, label_id)
    REFERENCES operations_labels(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_matches_supersedes_fkey
    FOREIGN KEY (network_id, supersedes_match_id)
    REFERENCES operations_carrier_billing_matches(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_matches_target_valid CHECK (
    (
      decision = 'matched'
      AND executing_organization_id IS NOT NULL
      AND shipment_id IS NOT NULL
      AND match_method <> 'none'
    )
    OR (
      decision <> 'matched'
      AND executing_organization_id IS NULL
      AND shipment_id IS NULL
      AND package_id IS NULL
      AND label_id IS NULL
    )
  ),
  CONSTRAINT operations_carrier_billing_matches_actor_valid CHECK (
    decided_by IS NOT NULL OR NULLIF(btrim(service_actor), '') IS NOT NULL
  ),
  CONSTRAINT operations_carrier_billing_matches_supersedes_unique UNIQUE (supersedes_match_id),
  CONSTRAINT operations_carrier_billing_matches_network_id_unique
    UNIQUE (network_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_carrier_billing_matches_charge
  ON operations_carrier_billing_matches (network_id, charge_id, decided_at DESC, id);

CREATE OR REPLACE FUNCTION validate_operations_carrier_billing_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  shipment_found boolean;
  shipment_package_id uuid;
  shipment_label_id uuid;
  prior_charge_id uuid;
BEGIN
  IF NEW.supersedes_match_id IS NOT NULL THEN
    SELECT prior.charge_id
    INTO prior_charge_id
    FROM operations_carrier_billing_matches prior
    WHERE prior.network_id = NEW.network_id
      AND prior.id = NEW.supersedes_match_id;

    IF prior_charge_id IS DISTINCT FROM NEW.charge_id THEN
      RAISE EXCEPTION 'Carrier billing match may only supersede a decision for the same charge';
    END IF;
  END IF;

  IF NEW.decision <> 'matched' THEN
    RETURN NEW;
  END IF;

  SELECT true, shipment.package_id, shipment.label_id
  INTO shipment_found, shipment_package_id, shipment_label_id
  FROM operations_shipments shipment
  WHERE shipment.organization_id = NEW.executing_organization_id
    AND shipment.id = NEW.shipment_id;

  IF shipment_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Matched carrier charge requires an existing shipment';
  END IF;
  IF NEW.package_id IS NOT NULL AND NEW.package_id IS DISTINCT FROM shipment_package_id THEN
    RAISE EXCEPTION 'Carrier billing package does not belong to the matched shipment';
  END IF;
  IF NEW.label_id IS NOT NULL AND NEW.label_id IS DISTINCT FROM shipment_label_id THEN
    RAISE EXCEPTION 'Carrier billing label does not belong to the matched shipment';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_carrier_billing_match_write
  ON operations_carrier_billing_matches;
CREATE TRIGGER validate_operations_carrier_billing_match_write
BEFORE INSERT ON operations_carrier_billing_matches
FOR EACH ROW EXECUTE FUNCTION validate_operations_carrier_billing_match();

CREATE OR REPLACE VIEW operations_carrier_billing_current_matches AS
SELECT DISTINCT ON (match_decision.charge_id)
  match_decision.*
FROM operations_carrier_billing_matches match_decision
ORDER BY match_decision.charge_id, match_decision.decided_at DESC, match_decision.id DESC;

CREATE TABLE IF NOT EXISTS operations_carrier_billing_routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gbr'),
  network_id uuid NOT NULL,
  name text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  match_mode text NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all', 'any')),
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  outputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_shipper_party_id uuid NOT NULL,
  version_number integer NOT NULL DEFAULT 1 CHECK (version_number > 0),
  supersedes_rule_id uuid,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'disabled', 'archived')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  approved_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_billing_routing_rules_global_valid
    CHECK (global_id ~ '^gbr[0-9]{7}$'),
  CONSTRAINT operations_carrier_billing_routing_rules_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_billing_routing_rules_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_routing_rules_network_fkey
    FOREIGN KEY (network_id)
    REFERENCES operations_carrier_rate_networks(id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_routing_rules_shipper_fkey
    FOREIGN KEY (network_id, target_shipper_party_id)
    REFERENCES operations_carrier_rate_parties(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_routing_rules_supersedes_fkey
    FOREIGN KEY (network_id, supersedes_rule_id)
    REFERENCES operations_carrier_billing_routing_rules(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_routing_rules_name_present
    CHECK (NULLIF(btrim(name), '') IS NOT NULL),
  CONSTRAINT operations_carrier_billing_routing_rules_conditions_valid
    CHECK (jsonb_typeof(conditions) = 'object'),
  CONSTRAINT operations_carrier_billing_routing_rules_outputs_valid
    CHECK (jsonb_typeof(outputs) = 'object'),
  CONSTRAINT operations_carrier_billing_routing_rules_dates_valid
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT operations_carrier_billing_routing_rules_version_unique
    UNIQUE (network_id, name, version_number),
  CONSTRAINT operations_carrier_billing_routing_rules_supersedes_unique
    UNIQUE (supersedes_rule_id),
  CONSTRAINT operations_carrier_billing_routing_rules_network_id_unique
    UNIQUE (network_id, id)
);

CREATE OR REPLACE FUNCTION validate_operations_carrier_billing_routing_rule()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_role text;
  prior_name text;
  prior_version_number integer;
BEGIN
  SELECT party.role
  INTO target_role
  FROM operations_carrier_rate_parties party
  WHERE party.network_id = NEW.network_id
    AND party.id = NEW.target_shipper_party_id;

  IF target_role IS DISTINCT FROM 'shipper' THEN
    RAISE EXCEPTION 'Carrier billing routing rule target must be a shipper party';
  END IF;
  IF NEW.version_number > 1 AND NEW.supersedes_rule_id IS NULL THEN
    RAISE EXCEPTION 'Versioned carrier billing routing rule must identify the superseded version';
  END IF;
  IF NEW.version_number = 1 AND NEW.supersedes_rule_id IS NOT NULL THEN
    RAISE EXCEPTION 'Initial carrier billing routing rule cannot supersede another version';
  END IF;

  IF NEW.supersedes_rule_id IS NOT NULL THEN
    SELECT prior.name, prior.version_number
    INTO prior_name, prior_version_number
    FROM operations_carrier_billing_routing_rules prior
    WHERE prior.network_id = NEW.network_id
      AND prior.id = NEW.supersedes_rule_id;

    IF lower(btrim(prior_name)) IS DISTINCT FROM lower(btrim(NEW.name)) THEN
      RAISE EXCEPTION 'Carrier billing routing rule may only supersede the same named rule';
    END IF;
    IF NEW.version_number IS DISTINCT FROM prior_version_number + 1 THEN
      RAISE EXCEPTION 'Carrier billing routing rule versions must be sequential';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_carrier_billing_routing_rule_write
  ON operations_carrier_billing_routing_rules;
CREATE TRIGGER validate_operations_carrier_billing_routing_rule_write
BEFORE INSERT ON operations_carrier_billing_routing_rules
FOR EACH ROW EXECUTE FUNCTION validate_operations_carrier_billing_routing_rule();

CREATE TABLE IF NOT EXISTS operations_carrier_billing_shipper_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gbs'),
  network_id uuid NOT NULL,
  charge_id uuid NOT NULL,
  decision text NOT NULL
    CHECK (decision IN ('assigned', 'unassigned', 'ambiguous', 'excluded')),
  shipper_party_id uuid,
  assignment_source text NOT NULL
    CHECK (assignment_source IN ('shipment_match', 'manual', 'routing_rule', 'none')),
  billing_match_id uuid,
  routing_rule_id uuid,
  routing_rule_version integer,
  supersedes_assignment_id uuid,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidate_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text,
  decided_by text REFERENCES app_users(email) ON DELETE SET NULL,
  service_actor text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_billing_shipper_assignments_global_valid
    CHECK (global_id ~ '^gbs[0-9]{7}$'),
  CONSTRAINT operations_carrier_billing_shipper_assignments_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_billing_shipper_assignments_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_shipper_assignments_charge_fkey
    FOREIGN KEY (network_id, charge_id)
    REFERENCES operations_carrier_billing_charges(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_shipper_assignments_shipper_fkey
    FOREIGN KEY (network_id, shipper_party_id)
    REFERENCES operations_carrier_rate_parties(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_shipper_assignments_match_fkey
    FOREIGN KEY (network_id, billing_match_id)
    REFERENCES operations_carrier_billing_matches(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_shipper_assignments_rule_fkey
    FOREIGN KEY (network_id, routing_rule_id)
    REFERENCES operations_carrier_billing_routing_rules(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_shipper_assignments_supersedes_fkey
    FOREIGN KEY (network_id, supersedes_assignment_id)
    REFERENCES operations_carrier_billing_shipper_assignments(network_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_shipper_assignments_target_valid CHECK (
    (
      decision = 'assigned'
      AND shipper_party_id IS NOT NULL
      AND assignment_source IN ('shipment_match', 'manual', 'routing_rule')
    )
    OR (
      decision <> 'assigned'
      AND shipper_party_id IS NULL
    )
  ),
  CONSTRAINT operations_carrier_billing_shipper_assignments_source_valid CHECK (
    (
      assignment_source = 'shipment_match'
      AND billing_match_id IS NOT NULL
      AND routing_rule_id IS NULL
      AND routing_rule_version IS NULL
    )
    OR (
      assignment_source = 'routing_rule'
      AND billing_match_id IS NULL
      AND routing_rule_id IS NOT NULL
      AND routing_rule_version IS NOT NULL
    )
    OR (
      assignment_source = 'manual'
      AND billing_match_id IS NULL
      AND routing_rule_id IS NULL
      AND routing_rule_version IS NULL
    )
    OR (
      assignment_source = 'none'
      AND decision <> 'assigned'
      AND billing_match_id IS NULL
      AND routing_rule_id IS NULL
      AND routing_rule_version IS NULL
    )
  ),
  CONSTRAINT operations_carrier_billing_shipper_assignments_actor_valid CHECK (
    decided_by IS NOT NULL OR NULLIF(btrim(service_actor), '') IS NOT NULL
  ),
  CONSTRAINT operations_carrier_billing_shipper_assignments_supersedes_unique
    UNIQUE (supersedes_assignment_id),
  CONSTRAINT operations_carrier_billing_shipper_assignments_network_id_unique
    UNIQUE (network_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_carrier_billing_shipper_assignments_charge
  ON operations_carrier_billing_shipper_assignments (
    network_id, charge_id, decided_at DESC, id
  );

CREATE OR REPLACE FUNCTION validate_operations_carrier_billing_shipper_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  match_charge_id uuid;
  match_decision text;
  target_role text;
  rule_target_shipper uuid;
  prior_charge_id uuid;
BEGIN
  IF NEW.supersedes_assignment_id IS NOT NULL THEN
    SELECT prior.charge_id
    INTO prior_charge_id
    FROM operations_carrier_billing_shipper_assignments prior
    WHERE prior.network_id = NEW.network_id
      AND prior.id = NEW.supersedes_assignment_id;

    IF prior_charge_id IS DISTINCT FROM NEW.charge_id THEN
      RAISE EXCEPTION 'Carrier billing shipper assignment may only supersede a decision for the same charge';
    END IF;
  END IF;

  IF NEW.shipper_party_id IS NOT NULL THEN
    SELECT party.role
    INTO target_role
    FROM operations_carrier_rate_parties party
    WHERE party.network_id = NEW.network_id
      AND party.id = NEW.shipper_party_id;

    IF target_role IS DISTINCT FROM 'shipper' THEN
      RAISE EXCEPTION 'Carrier billing assignment target must be a shipper party';
    END IF;
  END IF;

  IF NEW.billing_match_id IS NOT NULL THEN
    SELECT match_decision_row.charge_id, match_decision_row.decision
    INTO match_charge_id, match_decision
    FROM operations_carrier_billing_matches match_decision_row
    WHERE match_decision_row.network_id = NEW.network_id
      AND match_decision_row.id = NEW.billing_match_id;

    IF match_charge_id IS DISTINCT FROM NEW.charge_id THEN
      RAISE EXCEPTION 'Carrier billing assignment match belongs to a different charge';
    END IF;
  END IF;

  IF NEW.assignment_source = 'shipment_match' AND match_decision IS DISTINCT FROM 'matched' THEN
    RAISE EXCEPTION 'Shipment-derived shipper assignment requires a matched shipment decision';
  END IF;

  IF NEW.assignment_source = 'routing_rule' THEN
    SELECT rule.target_shipper_party_id
    INTO rule_target_shipper
    FROM operations_carrier_billing_routing_rules rule
    WHERE rule.network_id = NEW.network_id
      AND rule.id = NEW.routing_rule_id
      AND rule.version_number = NEW.routing_rule_version;

    IF rule_target_shipper IS NULL THEN
      RAISE EXCEPTION 'Carrier billing routing rule version was not found';
    END IF;
    IF NEW.decision = 'assigned'
       AND NEW.shipper_party_id IS DISTINCT FROM rule_target_shipper THEN
      RAISE EXCEPTION 'Carrier billing assignment does not match the routing rule target';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_carrier_billing_shipper_assignment_write
  ON operations_carrier_billing_shipper_assignments;
CREATE TRIGGER validate_operations_carrier_billing_shipper_assignment_write
BEFORE INSERT ON operations_carrier_billing_shipper_assignments
FOR EACH ROW EXECUTE FUNCTION validate_operations_carrier_billing_shipper_assignment();

CREATE OR REPLACE VIEW operations_carrier_billing_current_shipper_assignments AS
SELECT DISTINCT ON (assignment.charge_id)
  assignment.*
FROM operations_carrier_billing_shipper_assignments assignment
ORDER BY assignment.charge_id, assignment.decided_at DESC, assignment.id DESC;

CREATE TABLE IF NOT EXISTS operations_carrier_billing_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcr'),
  network_id uuid NOT NULL
    REFERENCES operations_carrier_rate_networks(id) ON DELETE RESTRICT,
  executing_organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  shipment_id uuid NOT NULL,
  quote_snapshot_id uuid NOT NULL,
  version_number integer NOT NULL DEFAULT 1 CHECK (version_number > 0),
  supersedes_reconciliation_id uuid,
  status text NOT NULL CHECK (status IN (
    'pending', 'provisional', 'needs_review', 'reconciled', 'adjusted'
  )),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  quoted_carrier_cost_minor bigint NOT NULL CHECK (quoted_carrier_cost_minor >= 0),
  actual_carrier_cost_minor bigint NOT NULL CHECK (actual_carrier_cost_minor >= 0),
  variance_minor bigint NOT NULL,
  matched_charge_count integer NOT NULL DEFAULT 0 CHECK (matched_charge_count >= 0),
  unresolved_candidate_count integer NOT NULL DEFAULT 0 CHECK (unresolved_candidate_count >= 0),
  assignment_exception_count integer NOT NULL DEFAULT 0 CHECK (assignment_exception_count >= 0),
  charge_category_totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  charge_match_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  account_resolution_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  statement_finalized_through date,
  idempotency_key text NOT NULL,
  reconciled_by text REFERENCES app_users(email) ON DELETE SET NULL,
  service_actor text,
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_billing_reconciliations_global_valid
    CHECK (global_id ~ '^gcr[0-9]{7}$'),
  CONSTRAINT operations_carrier_billing_reconciliations_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_billing_reconciliations_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_reconciliations_shipment_fkey
    FOREIGN KEY (executing_organization_id, shipment_id)
    REFERENCES operations_shipments(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_reconciliations_quote_fkey
    FOREIGN KEY (executing_organization_id, quote_snapshot_id)
    REFERENCES operations_carrier_quote_snapshots(executing_organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_reconciliations_supersedes_fkey
    FOREIGN KEY (supersedes_reconciliation_id)
    REFERENCES operations_carrier_billing_reconciliations(id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_reconciliations_variance_valid
    CHECK (variance_minor = actual_carrier_cost_minor - quoted_carrier_cost_minor),
  CONSTRAINT operations_carrier_billing_reconciliations_actor_valid CHECK (
    reconciled_by IS NOT NULL OR NULLIF(btrim(service_actor), '') IS NOT NULL
  ),
  CONSTRAINT operations_carrier_billing_reconciliations_version_unique
    UNIQUE (shipment_id, version_number),
  CONSTRAINT operations_carrier_billing_reconciliations_supersedes_unique
    UNIQUE (supersedes_reconciliation_id),
  CONSTRAINT operations_carrier_billing_reconciliations_idempotency_unique
    UNIQUE (network_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_operations_carrier_billing_reconciliations_shipment
  ON operations_carrier_billing_reconciliations (
    executing_organization_id, shipment_id, reconciled_at DESC, id
  );

CREATE OR REPLACE FUNCTION validate_operations_carrier_billing_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_shipment_id uuid;
  prior_version_number integer;
BEGIN
  IF NEW.version_number > 1 AND NEW.supersedes_reconciliation_id IS NULL THEN
    RAISE EXCEPTION 'Versioned carrier billing reconciliation must identify the superseded version';
  END IF;
  IF NEW.version_number = 1 AND NEW.supersedes_reconciliation_id IS NOT NULL THEN
    RAISE EXCEPTION 'Initial carrier billing reconciliation cannot supersede another version';
  END IF;

  IF NEW.supersedes_reconciliation_id IS NOT NULL THEN
    SELECT prior.shipment_id, prior.version_number
    INTO prior_shipment_id, prior_version_number
    FROM operations_carrier_billing_reconciliations prior
    WHERE prior.id = NEW.supersedes_reconciliation_id;

    IF prior_shipment_id IS DISTINCT FROM NEW.shipment_id THEN
      RAISE EXCEPTION 'Carrier billing reconciliation may only supersede the same shipment';
    END IF;
    IF NEW.version_number IS DISTINCT FROM prior_version_number + 1 THEN
      RAISE EXCEPTION 'Carrier billing reconciliation versions must be sequential';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_carrier_billing_reconciliation_write
  ON operations_carrier_billing_reconciliations;
CREATE TRIGGER validate_operations_carrier_billing_reconciliation_write
BEFORE INSERT ON operations_carrier_billing_reconciliations
FOR EACH ROW EXECUTE FUNCTION validate_operations_carrier_billing_reconciliation();

CREATE OR REPLACE VIEW operations_carrier_billing_current_reconciliations AS
SELECT DISTINCT ON (reconciliation.shipment_id)
  reconciliation.*
FROM operations_carrier_billing_reconciliations reconciliation
ORDER BY reconciliation.shipment_id, reconciliation.version_number DESC, reconciliation.id DESC;

-- Immutable configuration versions and financial evidence are superseded or
-- reversed by new rows. They are never edited or deleted in place.
DROP TRIGGER IF EXISTS protect_operations_carrier_rate_parties_mutation
  ON operations_carrier_rate_parties;
CREATE TRIGGER protect_operations_carrier_rate_parties_mutation
BEFORE UPDATE OR DELETE ON operations_carrier_rate_parties
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_carrier_account_authorizations_mutation
  ON operations_carrier_account_authorizations;
CREATE TRIGGER protect_operations_carrier_account_authorizations_mutation
BEFORE UPDATE OR DELETE ON operations_carrier_account_authorizations
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_carrier_rate_grants_mutation
  ON operations_carrier_rate_grants;
CREATE TRIGGER protect_operations_carrier_rate_grants_mutation
BEFORE UPDATE OR DELETE ON operations_carrier_rate_grants
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_carrier_rate_grant_users_mutation
  ON operations_carrier_rate_grant_users;
CREATE TRIGGER protect_operations_carrier_rate_grant_users_mutation
BEFORE UPDATE OR DELETE ON operations_carrier_rate_grant_users
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_carrier_rate_directives_mutation
  ON operations_carrier_rate_directives;
CREATE TRIGGER protect_operations_carrier_rate_directives_mutation
BEFORE UPDATE OR DELETE ON operations_carrier_rate_directives
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_carrier_quote_snapshots_mutation
  ON operations_carrier_quote_snapshots;
CREATE TRIGGER protect_operations_carrier_quote_snapshots_mutation
BEFORE UPDATE OR DELETE ON operations_carrier_quote_snapshots
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_settlement_entries_mutation
  ON operations_settlement_entries;
CREATE TRIGGER protect_operations_settlement_entries_mutation
BEFORE UPDATE OR DELETE ON operations_settlement_entries
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_settlement_events_mutation
  ON operations_settlement_events;
CREATE TRIGGER protect_operations_settlement_events_mutation
BEFORE UPDATE OR DELETE ON operations_settlement_events
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_carrier_billing_statements_mutation
  ON operations_carrier_billing_statements;
CREATE TRIGGER protect_operations_carrier_billing_statements_mutation
BEFORE UPDATE OR DELETE ON operations_carrier_billing_statements
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_carrier_billing_account_resolutions_mutation
  ON operations_carrier_billing_account_resolutions;
CREATE TRIGGER protect_operations_carrier_billing_account_resolutions_mutation
BEFORE UPDATE OR DELETE ON operations_carrier_billing_account_resolutions
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_carrier_billing_charges_mutation
  ON operations_carrier_billing_charges;
CREATE TRIGGER protect_operations_carrier_billing_charges_mutation
BEFORE UPDATE OR DELETE ON operations_carrier_billing_charges
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_carrier_billing_matches_mutation
  ON operations_carrier_billing_matches;
CREATE TRIGGER protect_operations_carrier_billing_matches_mutation
BEFORE UPDATE OR DELETE ON operations_carrier_billing_matches
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_carrier_billing_routing_rules_mutation
  ON operations_carrier_billing_routing_rules;
CREATE TRIGGER protect_operations_carrier_billing_routing_rules_mutation
BEFORE UPDATE OR DELETE ON operations_carrier_billing_routing_rules
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_carrier_billing_shipper_assignments_mutation
  ON operations_carrier_billing_shipper_assignments;
CREATE TRIGGER protect_operations_carrier_billing_shipper_assignments_mutation
BEFORE UPDATE OR DELETE ON operations_carrier_billing_shipper_assignments
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_carrier_billing_reconciliations_mutation
  ON operations_carrier_billing_reconciliations;
CREATE TRIGGER protect_operations_carrier_billing_reconciliations_mutation
BEFORE UPDATE OR DELETE ON operations_carrier_billing_reconciliations
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

-- Access remains least-privilege. Existing owners can configure their own rate
-- network; non-owners receive no new capability automatically.
UPDATE app_users
SET permissions = permissions || '{
  "manageCarrierRateNetworks":false,
  "grantCarrierRateAccess":false,
  "viewCarrierCost":false,
  "reconcileCarrierBilling":false,
  "approveCarrierSettlement":false
}'::jsonb
WHERE role <> 'owner';

UPDATE app_user_organization_memberships
SET permissions = permissions || CASE
  WHEN role = 'owner' THEN '{
    "manageCarrierRateNetworks":true,
    "grantCarrierRateAccess":true,
    "viewCarrierCost":true,
    "reconcileCarrierBilling":true,
    "approveCarrierSettlement":true
  }'::jsonb
  ELSE '{
    "manageCarrierRateNetworks":false,
    "grantCarrierRateAccess":false,
    "viewCarrierCost":false,
    "reconcileCarrierBilling":false,
    "approveCarrierSettlement":false
  }'::jsonb
END;
