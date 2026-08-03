-- Shopify checkout-rating configuration and immutable callback evidence.
--
-- The provider callback stores customer-neutral request evidence only. Raw
-- destination or customer fields are represented exclusively by a one-way
-- destination fingerprint. The callback is a read/compute boundary, so every
-- receipt and reconciliation row structurally records zero provider writes.

INSERT INTO global_reference_entity_types (
  prefix, entity_type, display_name
) VALUES
  (
    'gscf',
    'operations.shopify_carrier_service_config',
    'Shopify carrier service configuration'
  ),
  (
    'gsqr',
    'operations.shopify_checkout_rate_receipt',
    'Shopify checkout rate receipt'
  ),
  (
    'gsqc',
    'operations.shopify_checkout_rate_reconciliation',
    'Shopify checkout rate reconciliation'
  )
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

-- Carrier rating requires actual outside dimensions. Existing active material
-- rows remain valid with these nullable columns; callback configuration
-- readiness below prevents selecting a row until explicit, evidenced outside
-- dimensions are present.
ALTER TABLE operations_packaging_materials
  ADD COLUMN IF NOT EXISTS rated_outer_length_mm integer,
  ADD COLUMN IF NOT EXISTS rated_outer_width_mm integer,
  ADD COLUMN IF NOT EXISTS rated_outer_height_mm integer,
  ADD COLUMN IF NOT EXISTS rated_outer_dimension_evidence_type text,
  ADD COLUMN IF NOT EXISTS rated_outer_dimension_evidence_reference text,
  ADD COLUMN IF NOT EXISTS rated_outer_dimension_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS rated_outer_dimension_confirmed_by text
    REFERENCES app_users(email) ON DELETE SET NULL;

ALTER TABLE operations_packaging_materials
  DROP CONSTRAINT IF EXISTS
    operations_packaging_materials_rated_outer_evidence_valid,
  ADD CONSTRAINT
    operations_packaging_materials_rated_outer_evidence_valid
  CHECK (
    (
      rated_outer_length_mm IS NULL
      AND rated_outer_width_mm IS NULL
      AND rated_outer_height_mm IS NULL
      AND rated_outer_dimension_evidence_type IS NULL
      AND rated_outer_dimension_evidence_reference IS NULL
      AND rated_outer_dimension_confirmed_at IS NULL
      AND rated_outer_dimension_confirmed_by IS NULL
    )
    OR (
      rated_outer_length_mm > 0
      AND rated_outer_width_mm > 0
      AND rated_outer_height_mm > 0
      AND rated_outer_dimension_evidence_type IN (
        'customer_confirmed', 'measured', 'provider', 'legacy'
      )
      AND length(btrim(rated_outer_dimension_evidence_reference))
        BETWEEN 1 AND 500
      AND rated_outer_dimension_confirmed_at IS NOT NULL
    )
  );

COMMENT ON CONSTRAINT
  operations_packaging_materials_rated_outer_evidence_valid
  ON operations_packaging_materials IS
  'Rated outside dimensions and their authority are all absent or complete and positive. Existing active rows may remain incomplete, but cannot be selected by a ready Shopify callback configuration.';

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_json_is_customer_neutral(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH RECURSIVE entries(key, node) AS (
    SELECT NULL::text, value
    UNION ALL
    SELECT child.key, child.node
    FROM entries parent
    CROSS JOIN LATERAL (
      SELECT object_entry.key, object_entry.value AS node
      FROM jsonb_each(
        CASE
          WHEN jsonb_typeof(parent.node) = 'object' THEN parent.node
          ELSE '{}'::jsonb
        END
      ) object_entry
      UNION ALL
      SELECT NULL::text, array_entry.value AS node
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(parent.node) = 'array' THEN parent.node
          ELSE '[]'::jsonb
        END
      ) array_entry
    ) child
  )
  SELECT value IS NOT NULL
    AND jsonb_typeof(value) = 'object'
    AND octet_length(value::text) BETWEEN 2 AND 1048576
    AND NOT EXISTS (
      SELECT 1
      FROM entries
      WHERE regexp_replace(
        lower(key), '[^a-z0-9]', '', 'g'
      ) IN (
        'authorization',
        'accesstoken',
        'refreshtoken',
        'clientsecret',
        'secret',
        'secretid',
        'password',
        'apikey',
        'privatekey',
        'xshopifyaccesstoken',
        'email',
        'customeremail',
        'recipientemail',
        'contactemail',
        'shippingemail',
        'phone',
        'customerphone',
        'recipientphone',
        'contactphone',
        'shippingphone',
        'name',
        'firstname',
        'lastname',
        'company',
        'customer',
        'customerid',
        'address',
        'address1',
        'address2',
        'line1',
        'line2',
        'city',
        'region',
        'province',
        'state',
        'postalcode',
        'zipcode',
        'zip',
        'country',
        'countrycode',
        'latitude',
        'longitude'
      )
    )
$$;

CREATE TABLE IF NOT EXISTS operations_shopify_carrier_service_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gscf'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  service_gid text,
  registration_state text NOT NULL DEFAULT 'unconfigured' CHECK (
    registration_state IN (
      'unconfigured',
      'shadow_simulated',
      'registered',
      'disabled',
      'error'
    )
  ),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  activation_revision integer NOT NULL CHECK (activation_revision >= 1),
  callback_token_version integer NOT NULL CHECK (callback_token_version > 0),
  callback_token_hash text NOT NULL CHECK (
    callback_token_hash ~ '^[a-f0-9]{64}$'
  ),
  policy_revision bigint NOT NULL CHECK (policy_revision >= 1),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  policy_snapshot jsonb NOT NULL,
  inventory_max_age_seconds integer NOT NULL CHECK (
    inventory_max_age_seconds BETWEEN 30 AND 86400
  ),
  quote_ttl_seconds integer NOT NULL CHECK (
    quote_ttl_seconds BETWEEN 30 AND 900
  ),
  order_reconciliation_window_seconds integer NOT NULL CHECK (
    order_reconciliation_window_seconds BETWEEN 60 AND 172800
  ),
  algorithm_version text NOT NULL,
  last_error_code text,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shopify_carrier_service_configs_global_valid
    CHECK (global_id ~ '^gscf[0-9]{7}$'),
  CONSTRAINT operations_shopify_carrier_service_configs_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_shopify_carrier_service_configs_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_carrier_service_configs_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_carrier_service_configs_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_carrier_service_configs_account_unique
    UNIQUE (organization_id, integration_account_id),
  CONSTRAINT operations_shopify_carrier_service_configs_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_shopify_carrier_service_configs_policy_redacted
    CHECK (
      operations_commerce_external_effect_json_is_redacted(policy_snapshot)
    ),
  CONSTRAINT operations_shopify_carrier_service_configs_text_valid CHECK (
    length(btrim(algorithm_version)) BETWEEN 1 AND 160
    AND algorithm_version !~ '[[:cntrl:]]'
    AND (
      service_gid IS NULL
      OR service_gid ~
        '^gid://shopify/DeliveryCarrierService/[0-9]+$'
    )
    AND (
      last_error_code IS NULL
      OR (
        length(btrim(last_error_code)) BETWEEN 3 AND 128
        AND last_error_code !~ '[[:cntrl:]]'
      )
    )
  ),
  CONSTRAINT operations_shopify_carrier_service_configs_state_valid CHECK (
    (
      registration_state = 'shadow_simulated'
      AND service_gid IS NULL
      AND last_error_code IS NULL
    )
    OR (
      registration_state = 'registered'
      AND service_gid IS NOT NULL
      AND last_error_code IS NULL
    )
    OR (
      registration_state = 'error'
      AND last_error_code IS NOT NULL
    )
    OR registration_state IN ('unconfigured', 'disabled')
  ),
  CONSTRAINT operations_shopify_carrier_service_configs_ttl_valid CHECK (
    quote_ttl_seconds <= inventory_max_age_seconds
  )
);

CREATE TABLE IF NOT EXISTS
  operations_shopify_carrier_service_config_materials (
    organization_id uuid NOT NULL,
    config_id uuid NOT NULL,
    selection_sequence integer NOT NULL CHECK (
      selection_sequence BETWEEN 1 AND 8
    ),
    packaging_material_id uuid NOT NULL,
    packaging_material_row_version bigint NOT NULL CHECK (
      packaging_material_row_version >= 0
    ),
    PRIMARY KEY (organization_id, config_id, selection_sequence),
    CONSTRAINT
      operations_shopify_carrier_service_config_materials_config_fkey
      FOREIGN KEY (organization_id, config_id)
      REFERENCES operations_shopify_carrier_service_configs(
        organization_id, id
    ) ON DELETE RESTRICT,
    CONSTRAINT
      op_shopify_cs_config_materials_material_fkey
      FOREIGN KEY (organization_id, packaging_material_id)
      REFERENCES operations_packaging_materials(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT
      operations_shopify_carrier_service_config_materials_unique
      UNIQUE (organization_id, config_id, packaging_material_id)
  );

CREATE TABLE IF NOT EXISTS
  operations_shopify_carrier_service_config_carriers (
    organization_id uuid NOT NULL,
    config_id uuid NOT NULL,
    carrier_provider text NOT NULL CHECK (
      carrier_provider IN ('ups_rest', 'fedex_rest')
    ),
    carrier_account_id uuid NOT NULL,
    PRIMARY KEY (organization_id, config_id, carrier_provider),
    CONSTRAINT
      operations_shopify_carrier_service_config_carriers_config_fkey
      FOREIGN KEY (organization_id, config_id)
      REFERENCES operations_shopify_carrier_service_configs(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      operations_shopify_carrier_service_config_carriers_account_fkey
      FOREIGN KEY (organization_id, carrier_account_id)
      REFERENCES operations_carrier_accounts(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT
      operations_shopify_carrier_service_config_carriers_unique
      UNIQUE (organization_id, config_id, carrier_account_id)
  );

CREATE OR REPLACE FUNCTION
  operations_shopify_carrier_service_config_is_ready(
    requested_organization_id uuid,
    requested_config_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_shopify_carrier_service_configs config
    JOIN operations_integration_accounts account
      ON account.organization_id = config.organization_id
     AND account.id = config.integration_account_id
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN operations_activation_scopes activation
      ON activation.organization_id = config.organization_id
    JOIN operations_warehouses warehouse
      ON warehouse.organization_id = config.organization_id
     AND warehouse.id = config.warehouse_id
    WHERE config.organization_id = requested_organization_id
      AND config.id = requested_config_id
      AND config.registration_state IN (
        'shadow_simulated', 'registered'
      )
      AND account.integration_type = 'commerce'
      AND account.provider = 'shopify'
      AND account.environment = 'sandbox'
      AND account.status <> 'error'
      AND (
        config.registration_state <> 'registered'
        OR account.status = 'active'
      )
      AND account.commerce_credential_generation
        = config.credential_generation
      AND credential.credential_version = config.credential_generation
      AND credential.verification_status = 'verified'
      AND (
        (
          config.registration_state = 'registered'
          AND (
            (
              activation.state = 'active'
              AND activation.revision = config.activation_revision
            )
            OR (
              activation.state = 'shadow'
            )
          )
        )
        OR (
          config.registration_state = 'shadow_simulated'
          AND activation.state = 'shadow'
          AND activation.revision = config.activation_revision
        )
      )
      AND warehouse.status = 'active'
      AND (
        SELECT count(*)
        FROM operations_shopify_carrier_service_config_materials selected
        JOIN operations_packaging_materials material
          ON material.organization_id = selected.organization_id
         AND material.id = selected.packaging_material_id
        JOIN operations_packaging_material_stock stock
          ON stock.organization_id = material.organization_id
         AND stock.packaging_material_id = material.id
         AND stock.warehouse_id = config.warehouse_id
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
          AND material.status = 'active'
          AND material.row_version
            = selected.packaging_material_row_version
          AND material.rated_outer_length_mm > 0
          AND material.rated_outer_width_mm > 0
          AND material.rated_outer_height_mm > 0
          AND material.rated_outer_dimension_evidence_type IN (
            'customer_confirmed', 'measured', 'provider', 'legacy'
          )
          AND length(
            btrim(material.rated_outer_dimension_evidence_reference)
          ) BETWEEN 1 AND 500
          AND material.rated_outer_dimension_confirmed_at IS NOT NULL
          AND stock.is_available = true
          AND stock.on_hand_quantity > 0
      ) = (
        SELECT count(*)
        FROM operations_shopify_carrier_service_config_materials selected
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
      )
      AND (
        SELECT count(*)
        FROM operations_shopify_carrier_service_config_materials selected
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
      ) BETWEEN 1 AND 8
      AND (
        SELECT count(*)
        FROM operations_shopify_carrier_service_config_carriers selected
        JOIN operations_carrier_accounts carrier_account
          ON carrier_account.organization_id = selected.organization_id
         AND carrier_account.id = selected.carrier_account_id
        JOIN operations_integration_accounts carrier_integration
          ON carrier_integration.organization_id
            = carrier_account.organization_id
         AND carrier_integration.id
            = carrier_account.integration_account_id
        JOIN operations_carrier_credentials carrier_credential
          ON carrier_credential.organization_id
            = carrier_integration.organization_id
         AND carrier_credential.integration_account_id
            = carrier_integration.id
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
          AND carrier_account.status = 'active'
          AND carrier_integration.status = 'active'
          AND carrier_integration.integration_type = 'carrier'
          AND carrier_integration.provider = selected.carrier_provider
          AND carrier_integration.environment = 'sandbox'
          AND carrier_credential.verification_status = 'verified'
      ) = 2
      AND EXISTS (
        SELECT 1
        FROM operations_shopify_carrier_service_config_carriers selected
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
          AND selected.carrier_provider = 'ups_rest'
      )
      AND EXISTS (
        SELECT 1
        FROM operations_shopify_carrier_service_config_carriers selected
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
          AND selected.carrier_provider = 'fedex_rest'
      )
  )
$$;

CREATE OR REPLACE FUNCTION
  validate_operations_shopify_carrier_service_config()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_provider text;
  account_type text;
  account_environment text;
  account_generation integer;
  activation_revision integer;
  activation_state text;
BEGIN
  SELECT
    provider, integration_type, environment,
    commerce_credential_generation
    INTO account_provider, account_type, account_environment,
      account_generation
  FROM operations_integration_accounts
  WHERE organization_id = NEW.organization_id
    AND id = NEW.integration_account_id;
  SELECT revision, state INTO activation_revision, activation_state
  FROM operations_activation_scopes
  WHERE organization_id = NEW.organization_id;

  IF account_provider IS DISTINCT FROM 'shopify'
     OR account_type IS DISTINCT FROM 'commerce'
     OR account_environment IS DISTINCT FROM 'sandbox' THEN
    RAISE EXCEPTION
      'Shopify carrier service configuration requires a sandbox Shopify commerce account';
  END IF;
  IF account_generation IS DISTINCT FROM NEW.credential_generation
     OR activation_revision IS DISTINCT FROM NEW.activation_revision THEN
    RAISE EXCEPTION
      'Shopify carrier service configuration revision fence is stale';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.id,
      NEW.global_id,
      NEW.organization_id,
      NEW.integration_account_id,
      NEW.created_by,
      NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.id,
      OLD.global_id,
      OLD.organization_id,
      OLD.integration_account_id,
      OLD.created_by,
      OLD.created_at
    ) THEN
      RAISE EXCEPTION
        'Shopify carrier service configuration identity is immutable';
    END IF;
    IF NEW.row_version <> OLD.row_version + 1 THEN
      RAISE EXCEPTION
        'Shopify carrier service configuration row version must advance once';
    END IF;
  END IF;

  IF NEW.registration_state = 'registered'
     AND activation_state IS DISTINCT FROM 'active' THEN
    IF TG_OP = 'INSERT'
       OR (
         TG_OP = 'UPDATE'
         AND OLD.registration_state <> 'registered'
       ) THEN
      RAISE EXCEPTION
        'Registering a Shopify CarrierService requires Active Operations';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_operations_shopify_carrier_service_config_write
  ON operations_shopify_carrier_service_configs;
CREATE TRIGGER
  validate_operations_shopify_carrier_service_config_write
BEFORE INSERT OR UPDATE
ON operations_shopify_carrier_service_configs
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_shopify_carrier_service_config();

CREATE OR REPLACE FUNCTION
  validate_operations_shopify_carrier_service_config_ready()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.registration_state IN ('shadow_simulated', 'registered')
     AND NOT operations_shopify_carrier_service_config_is_ready(
       NEW.organization_id,
       NEW.id
     ) THEN
    RAISE EXCEPTION
      'Shopify carrier service configuration is not callback-ready';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_operations_shopify_carrier_service_config_ready
  ON operations_shopify_carrier_service_configs;
CREATE CONSTRAINT TRIGGER
  validate_operations_shopify_carrier_service_config_ready
AFTER INSERT OR UPDATE
ON operations_shopify_carrier_service_configs
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_shopify_carrier_service_config_ready();

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_carrier_service_config_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Shopify carrier service configurations cannot be deleted';
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_carrier_service_config_delete
  ON operations_shopify_carrier_service_configs;
CREATE TRIGGER
  protect_operations_shopify_carrier_service_config_delete
BEFORE DELETE ON operations_shopify_carrier_service_configs
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_shopify_carrier_service_config_delete();

CREATE OR REPLACE FUNCTION
  validate_operations_shopify_carrier_service_config_child()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requested_organization_id uuid;
  requested_config_id uuid;
  config_state text;
  config_service_gid text;
  integration_provider text;
  integration_environment text;
BEGIN
  requested_organization_id := COALESCE(
    NEW.organization_id, OLD.organization_id
  );
  requested_config_id := COALESCE(NEW.config_id, OLD.config_id);
  SELECT registration_state, service_gid
    INTO config_state, config_service_gid
  FROM operations_shopify_carrier_service_configs
  WHERE organization_id = requested_organization_id
    AND id = requested_config_id;
  IF config_state NOT IN ('unconfigured', 'disabled', 'error')
     OR config_service_gid IS NOT NULL THEN
    RAISE EXCEPTION
      'Disable the provider CarrierService before changing callback bindings';
  END IF;

  IF TG_TABLE_NAME
       = 'operations_shopify_carrier_service_config_carriers'
     AND TG_OP <> 'DELETE' THEN
    SELECT integration.provider, integration.environment
      INTO integration_provider, integration_environment
    FROM operations_carrier_accounts carrier_account
    JOIN operations_integration_accounts integration
      ON integration.organization_id = carrier_account.organization_id
     AND integration.id = carrier_account.integration_account_id
    WHERE carrier_account.organization_id = NEW.organization_id
      AND carrier_account.id = NEW.carrier_account_id;
    IF integration_provider IS DISTINCT FROM NEW.carrier_provider
       OR integration_environment IS DISTINCT FROM 'sandbox' THEN
      RAISE EXCEPTION
        'Shopify callback carrier binding requires its sandbox provider account';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_shopify_cs_config_material_write
  ON operations_shopify_carrier_service_config_materials;
CREATE TRIGGER
  validate_shopify_cs_config_material_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_carrier_service_config_materials
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_shopify_carrier_service_config_child();

DROP TRIGGER IF EXISTS
  validate_shopify_cs_config_carrier_write
  ON operations_shopify_carrier_service_config_carriers;
CREATE TRIGGER
  validate_shopify_cs_config_carrier_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_carrier_service_config_carriers
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_shopify_carrier_service_config_child();

-- The order-intake boundary retains the same keyed, customer-neutral
-- destination identity used by the public callback plus the exact Shopify
-- service code selected at checkout. Plaintext destination data stays inside
-- the existing encrypted candidate snapshot.
ALTER TABLE operations_commerce_order_candidates
  ADD COLUMN IF NOT EXISTS checkout_destination_fingerprint text,
  ADD COLUMN IF NOT EXISTS checkout_shipping_service_code text;

ALTER TABLE operations_commerce_order_candidates
  DROP CONSTRAINT IF EXISTS
    operations_commerce_order_candidates_checkout_destination_valid,
  DROP CONSTRAINT IF EXISTS
    operations_commerce_order_candidates_checkout_service_valid,
  ADD CONSTRAINT
    operations_commerce_order_candidates_checkout_destination_valid
    CHECK (
      checkout_destination_fingerprint IS NULL
      OR checkout_destination_fingerprint ~ '^[a-f0-9]{64}$'
    ),
  ADD CONSTRAINT
    operations_commerce_order_candidates_checkout_service_valid
    CHECK (
      checkout_shipping_service_code IS NULL
      OR (
        length(btrim(checkout_shipping_service_code)) BETWEEN 3 AND 80
        AND checkout_shipping_service_code !~ '[[:cntrl:]]'
      )
    );

ALTER TABLE operations_commerce_order_candidates
  DROP CONSTRAINT IF EXISTS
    operations_commerce_order_candidates_org_id_unique,
  ADD CONSTRAINT operations_commerce_order_candidates_org_id_unique
    UNIQUE (organization_id, id);

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_checkout_order_candidate_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.checkout_destination_fingerprint
       IS DISTINCT FROM OLD.checkout_destination_fingerprint
     OR NEW.checkout_shipping_service_code
       IS DISTINCT FROM OLD.checkout_shipping_service_code
  THEN
    RAISE EXCEPTION
      'Shopify checkout order-source matching fields are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_checkout_order_candidate_fields
  ON operations_commerce_order_candidates;
CREATE TRIGGER
  protect_operations_shopify_checkout_order_candidate_fields
BEFORE UPDATE OF
  checkout_destination_fingerprint,
  checkout_shipping_service_code
ON operations_commerce_order_candidates
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_shopify_checkout_order_candidate_fields();

CREATE TABLE IF NOT EXISTS operations_shopify_checkout_rate_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gsqr'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  config_id uuid NOT NULL,
  config_row_version bigint NOT NULL CHECK (config_row_version >= 0),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  activation_revision integer NOT NULL CHECK (activation_revision >= 1),
  activation_state text NOT NULL CHECK (
    activation_state IN ('shadow', 'active')
  ),
  policy_revision bigint NOT NULL CHECK (policy_revision >= 1),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  warehouse_id uuid NOT NULL,
  algorithm_version text NOT NULL,
  request_fingerprint text NOT NULL CHECK (
    request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  destination_fingerprint text NOT NULL CHECK (
    destination_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  carrier_destination_fingerprint text NOT NULL CHECK (
    carrier_destination_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  line_quantity_fingerprint text NOT NULL CHECK (
    line_quantity_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  request_evidence_hash text NOT NULL CHECK (
    request_evidence_hash ~ '^[a-f0-9]{64}$'
  ),
  redacted_request_snapshot jsonb NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (
    status IN ('processing', 'succeeded', 'failed')
  ),
  lease_token uuid,
  lease_expires_at timestamptz,
  claimed_by text,
  attempt_count integer NOT NULL DEFAULT 1 CHECK (
    attempt_count BETWEEN 1 AND 20
  ),
  line_count integer NOT NULL CHECK (line_count BETWEEN 1 AND 500),
  package_count integer NOT NULL DEFAULT 0 CHECK (
    package_count BETWEEN 0 AND 50
  ),
  offer_count integer NOT NULL DEFAULT 0 CHECK (
    offer_count BETWEEN 0 AND 100
  ),
  package_plan_hash text CHECK (
    package_plan_hash IS NULL
    OR package_plan_hash ~ '^[a-f0-9]{64}$'
  ),
  result_hash text CHECK (
    result_hash IS NULL OR result_hash ~ '^[a-f0-9]{64}$'
  ),
  result_snapshot jsonb,
  error_code text,
  provider_write_count integer NOT NULL DEFAULT 0 CHECK (
    provider_write_count = 0
  ),
  inventory_snapshot_hash text NOT NULL CHECK (
    inventory_snapshot_hash ~ '^[a-f0-9]{64}$'
  ),
  inventory_snapshot_at timestamptz NOT NULL,
  reconciliation_window_seconds integer NOT NULL CHECK (
    reconciliation_window_seconds BETWEEN 60 AND 172800
  ),
  reconciliation_deadline_at timestamptz NOT NULL,
  expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shopify_checkout_rate_receipts_global_valid
    CHECK (global_id ~ '^gsqr[0-9]{7}$'),
  CONSTRAINT operations_shopify_checkout_rate_receipts_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_shopify_checkout_rate_receipts_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_checkout_rate_receipts_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_checkout_rate_receipts_config_fkey
    FOREIGN KEY (organization_id, config_id)
    REFERENCES operations_shopify_carrier_service_configs(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_checkout_rate_receipts_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_checkout_rate_receipts_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_shopify_checkout_rate_receipts_idempotency_unique
    UNIQUE (
      organization_id, integration_account_id, idempotency_key
    ),
  CONSTRAINT operations_shopify_checkout_rate_receipts_request_neutral
    CHECK (
      operations_shopify_checkout_json_is_customer_neutral(
        redacted_request_snapshot
      )
      AND (
        result_snapshot IS NULL
        OR operations_shopify_checkout_json_is_customer_neutral(
          result_snapshot
        )
      )
    ),
  CONSTRAINT operations_shopify_checkout_rate_receipts_text_valid CHECK (
    length(btrim(algorithm_version)) BETWEEN 1 AND 160
    AND algorithm_version !~ '[[:cntrl:]]'
    AND length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
    AND (
      claimed_by IS NULL
      OR (
        length(btrim(claimed_by)) BETWEEN 1 AND 200
        AND claimed_by !~ '[[:cntrl:]]'
      )
    )
    AND (
      error_code IS NULL
      OR (
        length(btrim(error_code)) BETWEEN 3 AND 128
        AND error_code !~ '[[:cntrl:]]'
      )
    )
  ),
  CONSTRAINT operations_shopify_checkout_rate_receipts_state_valid CHECK (
    reconciliation_deadline_at
      = created_at + make_interval(secs => reconciliation_window_seconds)
    AND
    (
      status = 'processing'
      AND lease_token IS NOT NULL
      AND lease_expires_at > updated_at
      AND claimed_by IS NOT NULL
      AND package_count = 0
      AND offer_count = 0
      AND package_plan_hash IS NULL
      AND result_hash IS NULL
      AND result_snapshot IS NULL
      AND error_code IS NULL
      AND expires_at IS NULL
      AND completed_at IS NULL
    )
    OR (
      status = 'succeeded'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND package_count BETWEEN 1 AND 50
      AND offer_count BETWEEN 1 AND 100
      AND package_plan_hash IS NOT NULL
      AND result_hash IS NOT NULL
      AND result_snapshot IS NOT NULL
      AND error_code IS NULL
      AND completed_at IS NOT NULL
      AND expires_at > completed_at
    )
    OR (
      status = 'failed'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND package_count = 0
      AND offer_count = 0
      AND package_plan_hash IS NULL
      AND result_hash IS NOT NULL
      AND result_snapshot IS NOT NULL
      AND error_code IS NOT NULL
      AND completed_at IS NOT NULL
      AND expires_at > completed_at
    )
  )
);

CREATE INDEX IF NOT EXISTS
  operations_shopify_checkout_rate_receipts_cache_idx
  ON operations_shopify_checkout_rate_receipts (
    organization_id,
    integration_account_id,
    config_id,
    config_row_version,
    activation_revision,
    activation_state,
    request_fingerprint,
    policy_hash,
    inventory_snapshot_hash,
    expires_at DESC
  )
  WHERE status IN ('succeeded', 'failed');

DROP INDEX IF EXISTS
  operations_shopify_checkout_rate_receipts_processing_unique;
CREATE UNIQUE INDEX
  operations_shopify_checkout_rate_receipts_processing_unique
  ON operations_shopify_checkout_rate_receipts (
    organization_id,
    integration_account_id,
    config_id,
    config_row_version,
    activation_revision,
    activation_state,
    request_fingerprint,
    policy_hash,
    inventory_snapshot_hash,
    idempotency_key
  )
  WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS operations_shopify_checkout_rate_receipt_lines (
  organization_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  line_key text NOT NULL,
  provider_variant_id text NOT NULL,
  sku text,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  unit_weight_grams integer NOT NULL CHECK (
    unit_weight_grams BETWEEN 0 AND 1000000
  ),
  requires_shipping boolean NOT NULL CHECK (requires_shipping = true),
  line_hash text NOT NULL CHECK (line_hash ~ '^[a-f0-9]{64}$'),
  line_snapshot jsonb NOT NULL,
  PRIMARY KEY (organization_id, receipt_id, line_key),
  CONSTRAINT operations_shopify_checkout_rate_receipt_lines_receipt_fkey
    FOREIGN KEY (organization_id, receipt_id)
    REFERENCES operations_shopify_checkout_rate_receipts(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_checkout_rate_receipt_lines_neutral
    CHECK (
      operations_shopify_checkout_json_is_customer_neutral(line_snapshot)
    ),
  CONSTRAINT operations_shopify_checkout_rate_receipt_lines_text_valid
    CHECK (
      length(btrim(line_key)) BETWEEN 1 AND 120
      AND line_key !~ '[[:cntrl:]]'
      AND length(btrim(provider_variant_id)) BETWEEN 1 AND 255
      AND provider_variant_id !~ '[[:cntrl:]]'
      AND (
        sku IS NULL
        OR (
          length(btrim(sku)) BETWEEN 1 AND 255
          AND sku !~ '[[:cntrl:]]'
        )
      )
    )
);

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_receipt_line_quantity_fingerprint(
    requested_organization_id uuid,
    requested_receipt_id uuid
  )
RETURNS text
LANGUAGE sql
STABLE
AS $$
  WITH grouped AS (
    SELECT
      provider_variant_id,
      sum(quantity)::bigint AS total_quantity
    FROM operations_shopify_checkout_rate_receipt_lines
    WHERE organization_id = requested_organization_id
      AND receipt_id = requested_receipt_id
    GROUP BY provider_variant_id
  )
  SELECT encode(
    digest(
      string_agg(
        octet_length(provider_variant_id)::text
          || ':' || provider_variant_id
          || '=' || total_quantity::text,
        E'\n'
        ORDER BY provider_variant_id COLLATE "C"
      ),
      'sha256'
    ),
    'hex'
  )
  FROM grouped;
$$;

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_order_line_quantity_fingerprint(
    requested_organization_id uuid,
    requested_order_candidate_id uuid
  )
RETURNS text
LANGUAGE sql
STABLE
AS $$
  WITH source_lines AS (
    SELECT external_variant_id, ordered_quantity
    FROM operations_commerce_order_candidate_lines
    WHERE organization_id = requested_organization_id
      AND order_candidate_id = requested_order_candidate_id
      AND requires_shipping
  ),
  grouped AS (
    SELECT
      external_variant_id,
      sum(ordered_quantity)::bigint AS total_quantity
    FROM source_lines
    WHERE external_variant_id IS NOT NULL
      AND ordered_quantity = trunc(ordered_quantity)
    GROUP BY external_variant_id
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM source_lines)
      OR EXISTS (
        SELECT 1
        FROM source_lines
        WHERE external_variant_id IS NULL
          OR ordered_quantity <> trunc(ordered_quantity)
      )
    THEN NULL
    ELSE (
      SELECT encode(
        digest(
          string_agg(
            octet_length(external_variant_id)::text
              || ':' || external_variant_id
              || '=' || total_quantity::text,
            E'\n'
            ORDER BY external_variant_id COLLATE "C"
          ),
          'sha256'
        ),
        'hex'
      )
      FROM grouped
    )
  END;
$$;

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_carrier_parcel_snapshot(
    package_key text,
    package_sequence integer,
    rated_outer_length_mm integer,
    rated_outer_width_mm integer,
    rated_outer_height_mm integer,
    gross_weight_grams integer
  )
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_build_object(
    'packageKey', package_key,
    'description', 'ClawPilot carton ' || package_sequence::text,
    'exteriorInches', jsonb_build_object(
      'length', ceil(rated_outer_length_mm::numeric / 25.4)::integer,
      'width', ceil(rated_outer_width_mm::numeric / 25.4)::integer,
      'height', ceil(rated_outer_height_mm::numeric / 25.4)::integer
    ),
    'grossPounds', greatest(
      0.1::numeric,
      ceil(
        (gross_weight_grams::numeric / 453.59237::numeric) * 10
      ) / 10
    )
  );
$$;

CREATE TABLE IF NOT EXISTS
  operations_shopify_checkout_rate_receipt_packages (
    organization_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    package_key text NOT NULL,
    package_sequence integer NOT NULL CHECK (
      package_sequence BETWEEN 1 AND 50
    ),
    packaging_material_id uuid NOT NULL,
    packaging_material_row_version bigint NOT NULL CHECK (
      packaging_material_row_version >= 0
    ),
    packaging_material_stock_id uuid NOT NULL,
    packaging_material_stock_row_version bigint NOT NULL CHECK (
      packaging_material_stock_row_version >= 0
    ),
    packaging_material_stock_on_hand_quantity integer NOT NULL CHECK (
      packaging_material_stock_on_hand_quantity > 0
    ),
    rated_outer_length_mm integer NOT NULL CHECK (
      rated_outer_length_mm > 0
    ),
    rated_outer_width_mm integer NOT NULL CHECK (
      rated_outer_width_mm > 0
    ),
    rated_outer_height_mm integer NOT NULL CHECK (
      rated_outer_height_mm > 0
    ),
    content_weight_grams integer NOT NULL CHECK (
      content_weight_grams > 0
    ),
    tare_weight_grams integer NOT NULL CHECK (tare_weight_grams > 0),
    gross_weight_grams integer NOT NULL CHECK (
      gross_weight_grams = content_weight_grams + tare_weight_grams
    ),
    carrier_parcel_snapshot jsonb GENERATED ALWAYS AS (
      operations_shopify_checkout_carrier_parcel_snapshot(
        package_key,
        package_sequence,
        rated_outer_length_mm,
        rated_outer_width_mm,
        rated_outer_height_mm,
        gross_weight_grams
      )
    ) STORED NOT NULL,
    allocation_count integer NOT NULL CHECK (
      allocation_count BETWEEN 1 AND 500
    ),
    package_hash text NOT NULL CHECK (package_hash ~ '^[a-f0-9]{64}$'),
    package_snapshot jsonb NOT NULL,
    PRIMARY KEY (organization_id, receipt_id, package_key),
    CONSTRAINT
      operations_shopify_checkout_rate_receipt_packages_receipt_fkey
      FOREIGN KEY (organization_id, receipt_id)
      REFERENCES operations_shopify_checkout_rate_receipts(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      operations_shopify_checkout_rate_receipt_packages_material_fkey
      FOREIGN KEY (organization_id, packaging_material_id)
      REFERENCES operations_packaging_materials(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT
      op_shopify_rate_packages_material_stock_fkey
      FOREIGN KEY (organization_id, packaging_material_stock_id)
      REFERENCES operations_packaging_material_stock(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT
      op_shopify_rate_packages_sequence_unique
      UNIQUE (organization_id, receipt_id, package_sequence),
    CONSTRAINT
      operations_shopify_checkout_rate_receipt_packages_neutral
      CHECK (
        operations_shopify_checkout_json_is_customer_neutral(
          package_snapshot
        )
      ),
    CONSTRAINT
      operations_shopify_checkout_rate_receipt_packages_text_valid
      CHECK (
        length(btrim(package_key)) BETWEEN 1 AND 100
        AND package_key !~ '[[:cntrl:]]'
      )
  );

CREATE TABLE IF NOT EXISTS
  operations_shopify_checkout_rate_receipt_allocations (
    organization_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    package_key text NOT NULL,
    line_key text NOT NULL,
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
    allocation_hash text NOT NULL CHECK (
      allocation_hash ~ '^[a-f0-9]{64}$'
    ),
    PRIMARY KEY (
      organization_id, receipt_id, package_key, line_key
    ),
    CONSTRAINT
      op_shopify_rate_allocations_package_fkey
      FOREIGN KEY (organization_id, receipt_id, package_key)
      REFERENCES operations_shopify_checkout_rate_receipt_packages(
        organization_id, receipt_id, package_key
      ) ON DELETE RESTRICT,
    CONSTRAINT
      operations_shopify_checkout_rate_receipt_allocations_line_fkey
      FOREIGN KEY (organization_id, receipt_id, line_key)
      REFERENCES operations_shopify_checkout_rate_receipt_lines(
        organization_id, receipt_id, line_key
      ) ON DELETE RESTRICT
  );

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_carrier_rate_matches(
    carrier_response jsonb,
    expected_service_code text,
    expected_service_name text,
    expected_amount_minor bigint,
    expected_currency text,
    expected_response_rate_hash text
  )
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH matching_rate AS (
    SELECT rate.value
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(carrier_response->'rates') = 'array'
          THEN carrier_response->'rates'
        ELSE '[]'::jsonb
      END
    ) rate(value)
    WHERE lower(rate.value->>'serviceCode')
      = lower(expected_service_code)
  )
  SELECT count(*) = 1
    AND bool_and(
      btrim(value->>'serviceName') = expected_service_name
      AND upper(value->>'currency') = expected_currency
      AND CASE
        WHEN value->>'amount'
          ~ '^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$'
        THEN ((value->>'amount')::numeric * 100)::bigint
          = expected_amount_minor
        ELSE false
      END
      AND encode(digest(value::text, 'sha256'), 'hex')
        = expected_response_rate_hash
    )
  FROM matching_rate;
$$;

CREATE TABLE IF NOT EXISTS operations_shopify_checkout_rate_receipt_offers (
  organization_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  carrier_provider text NOT NULL CHECK (
    carrier_provider IN ('ups_rest', 'fedex_rest')
  ),
  carrier_account_id uuid NOT NULL,
  carrier_rate_request_id uuid NOT NULL,
  carrier_rate_purpose text NOT NULL DEFAULT
    'cartonization_shipment_rate' CHECK (
      carrier_rate_purpose = 'cartonization_shipment_rate'
    ),
  carrier_request_hash text NOT NULL CHECK (
    carrier_request_hash ~ '^[a-f0-9]{64}$'
  ),
  carrier_response_rate_hash text NOT NULL CHECK (
    carrier_response_rate_hash ~ '^[a-f0-9]{64}$'
  ),
  shopify_service_code text NOT NULL,
  service_code text NOT NULL,
  service_name text NOT NULL,
  carrier_cost_minor bigint NOT NULL CHECK (carrier_cost_minor >= 0),
  customer_charge_minor bigint NOT NULL CHECK (
    customer_charge_minor >= 0
  ),
  checkout_adjustment_minor bigint NOT NULL DEFAULT 0 CHECK (
    checkout_adjustment_minor <= 0
  ),
  checkout_adjustment_kind text NOT NULL DEFAULT 'none' CHECK (
    checkout_adjustment_kind IN ('none', 'subsidy')
  ),
  checkout_adjustment_reason text,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  package_count integer NOT NULL CHECK (package_count BETWEEN 1 AND 50),
  package_plan_hash text NOT NULL CHECK (
    package_plan_hash ~ '^[a-f0-9]{64}$'
  ),
  min_delivery_date date,
  max_delivery_date date,
  offer_hash text NOT NULL CHECK (offer_hash ~ '^[a-f0-9]{64}$'),
  offer_snapshot jsonb NOT NULL,
  PRIMARY KEY (
    organization_id, receipt_id, shopify_service_code
  ),
  CONSTRAINT operations_shopify_checkout_rate_receipt_offers_receipt_fkey
    FOREIGN KEY (organization_id, receipt_id)
    REFERENCES operations_shopify_checkout_rate_receipts(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT
    operations_shopify_checkout_rate_receipt_offers_account_fkey
    FOREIGN KEY (organization_id, carrier_account_id)
    REFERENCES operations_carrier_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT
    operations_shopify_checkout_rate_receipt_offers_rate_fkey
    FOREIGN KEY (
      organization_id,
      carrier_provider,
      carrier_rate_purpose,
      carrier_rate_request_id
    )
    REFERENCES operations_carrier_rate_requests(
      organization_id, provider, purpose, id
    )
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_checkout_rate_receipt_offers_neutral
    CHECK (
      operations_shopify_checkout_json_is_customer_neutral(offer_snapshot)
    ),
  CONSTRAINT operations_shopify_checkout_rate_receipt_offers_text_valid
    CHECK (
      length(btrim(service_code)) BETWEEN 1 AND 80
      AND service_code !~ '[[:cntrl:]]'
      AND shopify_service_code
        ~ '^clawpilot:(ups|fedex):[A-Za-z0-9][A-Za-z0-9._-]{0,56}$'
      AND length(btrim(service_name)) BETWEEN 1 AND 160
      AND service_name !~ '[[:cntrl:]]'
      AND (
        min_delivery_date IS NULL
        OR max_delivery_date IS NULL
        OR min_delivery_date <= max_delivery_date
      )
      AND customer_charge_minor
        = carrier_cost_minor + checkout_adjustment_minor
      AND (
        (
          checkout_adjustment_kind = 'none'
          AND checkout_adjustment_minor = 0
          AND checkout_adjustment_reason IS NULL
        )
        OR (
          checkout_adjustment_kind = 'subsidy'
          AND checkout_adjustment_minor < 0
          AND length(btrim(checkout_adjustment_reason)) BETWEEN 3 AND 160
          AND checkout_adjustment_reason !~ '[[:cntrl:]]'
        )
      )
    )
);

CREATE OR REPLACE FUNCTION
  validate_operations_shopify_checkout_rate_receipt_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  config_account_id uuid;
  current_row_version bigint;
  current_generation integer;
  current_policy_revision bigint;
  current_policy_hash text;
  current_warehouse_id uuid;
  current_algorithm_version text;
  configured_inventory_max_age integer;
  configured_reconciliation_window integer;
  actual_activation_revision integer;
  actual_activation_state text;
BEGIN
  SELECT
    integration_account_id,
    row_version,
    credential_generation,
    policy_revision,
    policy_hash,
    warehouse_id,
    algorithm_version,
    inventory_max_age_seconds,
    order_reconciliation_window_seconds
    INTO
      config_account_id,
      current_row_version,
      current_generation,
      current_policy_revision,
      current_policy_hash,
      current_warehouse_id,
      current_algorithm_version,
      configured_inventory_max_age,
      configured_reconciliation_window
  FROM operations_shopify_carrier_service_configs
  WHERE organization_id = NEW.organization_id
    AND id = NEW.config_id;
  SELECT revision, state
    INTO actual_activation_revision, actual_activation_state
  FROM operations_activation_scopes
  WHERE organization_id = NEW.organization_id;

  IF config_account_id IS DISTINCT FROM NEW.integration_account_id
     OR current_row_version IS DISTINCT FROM NEW.config_row_version
     OR current_generation IS DISTINCT FROM NEW.credential_generation
     OR actual_activation_revision IS DISTINCT FROM NEW.activation_revision
     OR actual_activation_state IS DISTINCT FROM NEW.activation_state
     OR current_policy_revision IS DISTINCT FROM NEW.policy_revision
     OR current_policy_hash IS DISTINCT FROM NEW.policy_hash
     OR current_warehouse_id IS DISTINCT FROM NEW.warehouse_id
     OR current_algorithm_version IS DISTINCT FROM NEW.algorithm_version
     OR NOT operations_shopify_carrier_service_config_is_ready(
       NEW.organization_id,
       NEW.config_id
     )
  THEN
    RAISE EXCEPTION
      'Shopify checkout rating configuration fence is stale';
  END IF;

  IF NEW.status <> 'processing'
     OR NEW.inventory_snapshot_at
       < now() - make_interval(secs => configured_inventory_max_age)
     OR NEW.inventory_snapshot_at > now() + interval '5 minutes'
  THEN
    RAISE EXCEPTION
      'Shopify checkout receipt requires fresh inventory and a processing claim';
  END IF;
  NEW.reconciliation_window_seconds :=
    configured_reconciliation_window;
  NEW.reconciliation_deadline_at :=
    NEW.created_at + make_interval(
      secs => configured_reconciliation_window
    );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_operations_shopify_checkout_rate_receipt_insert
  ON operations_shopify_checkout_rate_receipts;
CREATE TRIGGER
  validate_operations_shopify_checkout_rate_receipt_insert
BEFORE INSERT ON operations_shopify_checkout_rate_receipts
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_shopify_checkout_rate_receipt_insert();

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_checkout_rate_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  retained_line_count bigint;
  retained_package_count bigint;
  retained_offer_count bigint;
  allocation_mismatch_count bigint;
  package_allocation_mismatch_count bigint;
  package_weight_mismatch_count bigint;
  package_stock_mismatch_count bigint;
  offer_mismatch_count bigint;
  retained_line_quantity_fingerprint text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shopify checkout rate receipts cannot be deleted';
  END IF;
  IF OLD.status <> 'processing' THEN
    RAISE EXCEPTION
      'Terminal Shopify checkout rate receipts are immutable';
  END IF;
  IF ROW(
    NEW.id,
    NEW.global_id,
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.config_id,
    NEW.config_row_version,
    NEW.credential_generation,
    NEW.activation_revision,
    NEW.activation_state,
    NEW.policy_revision,
    NEW.policy_hash,
    NEW.warehouse_id,
    NEW.algorithm_version,
    NEW.request_fingerprint,
    NEW.destination_fingerprint,
    NEW.carrier_destination_fingerprint,
    NEW.line_quantity_fingerprint,
    NEW.request_evidence_hash,
    NEW.redacted_request_snapshot,
    NEW.currency,
    NEW.idempotency_key,
    NEW.line_count,
    NEW.provider_write_count,
    NEW.inventory_snapshot_hash,
    NEW.inventory_snapshot_at,
    NEW.reconciliation_window_seconds,
    NEW.reconciliation_deadline_at,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.global_id,
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.config_id,
    OLD.config_row_version,
    OLD.credential_generation,
    OLD.activation_revision,
    OLD.activation_state,
    OLD.policy_revision,
    OLD.policy_hash,
    OLD.warehouse_id,
    OLD.algorithm_version,
    OLD.request_fingerprint,
    OLD.destination_fingerprint,
    OLD.carrier_destination_fingerprint,
    OLD.line_quantity_fingerprint,
    OLD.request_evidence_hash,
    OLD.redacted_request_snapshot,
    OLD.currency,
    OLD.idempotency_key,
    OLD.line_count,
    OLD.provider_write_count,
    OLD.inventory_snapshot_hash,
    OLD.inventory_snapshot_at,
    OLD.reconciliation_window_seconds,
    OLD.reconciliation_deadline_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'Shopify checkout receipt request evidence is immutable';
  END IF;

  IF NEW.status = 'processing' THEN
    IF NEW.attempt_count <> OLD.attempt_count + 1
       OR NEW.lease_token IS NULL
       OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
       OR NEW.lease_expires_at <= now()
       OR NEW.package_count <> 0
       OR NEW.offer_count <> 0
       OR NEW.package_plan_hash IS NOT NULL
       OR NEW.result_hash IS NOT NULL
       OR NEW.result_snapshot IS NOT NULL
       OR NEW.error_code IS NOT NULL
       OR NEW.expires_at IS NOT NULL
       OR NEW.completed_at IS NOT NULL
    THEN
      RAISE EXCEPTION
        'Shopify checkout receipt reclaim is invalid';
    END IF;
    RETURN NEW;
  END IF;

  SELECT count(*) INTO retained_line_count
  FROM operations_shopify_checkout_rate_receipt_lines line
  WHERE line.organization_id = NEW.organization_id
    AND line.receipt_id = NEW.id;
  IF retained_line_count <> NEW.line_count THEN
    RAISE EXCEPTION
      'Shopify checkout receipt line evidence is incomplete';
  END IF;
  SELECT operations_shopify_checkout_receipt_line_quantity_fingerprint(
    NEW.organization_id,
    NEW.id
  ) INTO retained_line_quantity_fingerprint;
  IF retained_line_quantity_fingerprint
       IS DISTINCT FROM NEW.line_quantity_fingerprint
  THEN
    RAISE EXCEPTION
      'Shopify checkout receipt line quantity fingerprint is invalid';
  END IF;

  IF NEW.status = 'failed' THEN
    IF EXISTS (
      SELECT 1
      FROM operations_shopify_checkout_rate_receipt_packages package
      WHERE package.organization_id = NEW.organization_id
        AND package.receipt_id = NEW.id
    ) OR EXISTS (
      SELECT 1
      FROM operations_shopify_checkout_rate_receipt_offers offer
      WHERE offer.organization_id = NEW.organization_id
        AND offer.receipt_id = NEW.id
    ) THEN
      RAISE EXCEPTION
        'Failed Shopify checkout receipts cannot retain quote output';
    END IF;
    RETURN NEW;
  END IF;

  SELECT count(*) INTO retained_package_count
  FROM operations_shopify_checkout_rate_receipt_packages package
  WHERE package.organization_id = NEW.organization_id
    AND package.receipt_id = NEW.id;
  SELECT count(*) INTO retained_offer_count
  FROM operations_shopify_checkout_rate_receipt_offers offer
  WHERE offer.organization_id = NEW.organization_id
    AND offer.receipt_id = NEW.id;
  SELECT count(*) INTO allocation_mismatch_count
  FROM (
    SELECT line.line_key
    FROM operations_shopify_checkout_rate_receipt_lines line
    LEFT JOIN operations_shopify_checkout_rate_receipt_allocations allocation
      ON allocation.organization_id = line.organization_id
     AND allocation.receipt_id = line.receipt_id
     AND allocation.line_key = line.line_key
    WHERE line.organization_id = NEW.organization_id
      AND line.receipt_id = NEW.id
    GROUP BY line.line_key, line.quantity
    HAVING COALESCE(sum(allocation.quantity), 0) <> line.quantity
  ) mismatch;
  SELECT count(*) INTO package_allocation_mismatch_count
  FROM (
    SELECT package.package_key
    FROM operations_shopify_checkout_rate_receipt_packages package
    LEFT JOIN operations_shopify_checkout_rate_receipt_allocations allocation
      ON allocation.organization_id = package.organization_id
     AND allocation.receipt_id = package.receipt_id
     AND allocation.package_key = package.package_key
    WHERE package.organization_id = NEW.organization_id
      AND package.receipt_id = NEW.id
    GROUP BY package.package_key, package.allocation_count
    HAVING count(allocation.line_key) <> package.allocation_count
  ) mismatch;
  SELECT count(*) INTO offer_mismatch_count
  FROM operations_shopify_checkout_rate_receipt_offers offer
  WHERE offer.organization_id = NEW.organization_id
    AND offer.receipt_id = NEW.id
    AND (
      offer.package_count <> NEW.package_count
      OR offer.package_plan_hash <> NEW.package_plan_hash
      OR offer.currency <> NEW.currency
    );
  SELECT count(*) INTO package_weight_mismatch_count
  FROM (
    SELECT package.package_key
    FROM operations_shopify_checkout_rate_receipt_packages package
    JOIN operations_packaging_materials material
      ON material.organization_id = package.organization_id
     AND material.id = package.packaging_material_id
    LEFT JOIN operations_shopify_checkout_rate_receipt_allocations allocation
      ON allocation.organization_id = package.organization_id
     AND allocation.receipt_id = package.receipt_id
     AND allocation.package_key = package.package_key
    LEFT JOIN operations_shopify_checkout_rate_receipt_lines line
      ON line.organization_id = allocation.organization_id
     AND line.receipt_id = allocation.receipt_id
     AND line.line_key = allocation.line_key
    WHERE package.organization_id = NEW.organization_id
      AND package.receipt_id = NEW.id
    GROUP BY
      package.package_key,
      package.content_weight_grams,
      package.gross_weight_grams,
      material.max_weight_grams
    HAVING
      COALESCE(
        sum(allocation.quantity::bigint * line.unit_weight_grams),
        0
      ) <> package.content_weight_grams
      OR (
        material.max_weight_grams IS NOT NULL
        AND package.gross_weight_grams > material.max_weight_grams
      )
  ) mismatch;
  SELECT count(*) INTO package_stock_mismatch_count
  FROM (
    SELECT package.packaging_material_stock_id
    FROM operations_shopify_checkout_rate_receipt_packages package
    JOIN operations_packaging_material_stock stock
      ON stock.organization_id = package.organization_id
     AND stock.id = package.packaging_material_stock_id
    WHERE package.organization_id = NEW.organization_id
      AND package.receipt_id = NEW.id
    GROUP BY
      package.packaging_material_stock_id,
      package.packaging_material_stock_row_version,
      package.packaging_material_stock_on_hand_quantity,
      stock.row_version,
      stock.on_hand_quantity,
      stock.is_available
    HAVING
      stock.is_available IS DISTINCT FROM true
      OR stock.row_version
        IS DISTINCT FROM package.packaging_material_stock_row_version
      OR stock.on_hand_quantity
        IS DISTINCT FROM package.packaging_material_stock_on_hand_quantity
      OR count(*) > package.packaging_material_stock_on_hand_quantity
  ) mismatch;

  IF retained_package_count <> NEW.package_count
     OR retained_offer_count <> NEW.offer_count
     OR allocation_mismatch_count <> 0
     OR package_allocation_mismatch_count <> 0
     OR package_weight_mismatch_count <> 0
     OR package_stock_mismatch_count <> 0
     OR offer_mismatch_count <> 0
  THEN
    RAISE EXCEPTION
      'Shopify checkout receipt package, allocation, or offer evidence is incomplete';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_checkout_rate_receipt_write
  ON operations_shopify_checkout_rate_receipts;
CREATE TRIGGER
  protect_operations_shopify_checkout_rate_receipt_write
BEFORE UPDATE OR DELETE ON operations_shopify_checkout_rate_receipts
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_shopify_checkout_rate_receipt();

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_checkout_rate_receipt_child()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_status text;
  requested_organization_id uuid;
  requested_receipt_id uuid;
  retained_count bigint;
  material_ready boolean;
  offer_ready boolean;
BEGIN
  requested_organization_id := COALESCE(
    NEW.organization_id, OLD.organization_id
  );
  requested_receipt_id := COALESCE(NEW.receipt_id, OLD.receipt_id);
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify checkout receipt child evidence is immutable';
  END IF;
  SELECT status INTO receipt_status
  FROM operations_shopify_checkout_rate_receipts
  WHERE organization_id = requested_organization_id
    AND id = requested_receipt_id;
  IF receipt_status IS DISTINCT FROM 'processing' THEN
    RAISE EXCEPTION
      'Shopify checkout receipt children require a processing claim';
  END IF;

  IF TG_TABLE_NAME
       = 'operations_shopify_checkout_rate_receipt_lines' THEN
    SELECT count(*) INTO retained_count
    FROM operations_shopify_checkout_rate_receipt_lines
    WHERE organization_id = NEW.organization_id
      AND receipt_id = NEW.receipt_id;
    IF retained_count >= (
      SELECT line_count
      FROM operations_shopify_checkout_rate_receipts
      WHERE organization_id = NEW.organization_id
        AND id = NEW.receipt_id
    ) THEN
      RAISE EXCEPTION
        'Shopify checkout receipt line count is already complete';
    END IF;
  ELSIF TG_TABLE_NAME
       = 'operations_shopify_checkout_rate_receipt_packages' THEN
    PERFORM 1
    FROM operations_packaging_material_stock stock
    WHERE stock.organization_id = NEW.organization_id
      AND stock.id = NEW.packaging_material_stock_id
    FOR SHARE;
    SELECT EXISTS (
      SELECT 1
      FROM operations_shopify_checkout_rate_receipts receipt
      JOIN operations_shopify_carrier_service_config_materials selected
        ON selected.organization_id = receipt.organization_id
       AND selected.config_id = receipt.config_id
       AND selected.packaging_material_id = NEW.packaging_material_id
      JOIN operations_packaging_materials material
        ON material.organization_id = selected.organization_id
       AND material.id = selected.packaging_material_id
      JOIN operations_packaging_material_stock stock
        ON stock.organization_id = material.organization_id
       AND stock.id = NEW.packaging_material_stock_id
       AND stock.packaging_material_id = material.id
       AND stock.warehouse_id = receipt.warehouse_id
      WHERE receipt.organization_id = NEW.organization_id
        AND receipt.id = NEW.receipt_id
        AND selected.packaging_material_row_version
          = NEW.packaging_material_row_version
        AND material.row_version = NEW.packaging_material_row_version
        AND stock.row_version
          = NEW.packaging_material_stock_row_version
        AND stock.on_hand_quantity
          = NEW.packaging_material_stock_on_hand_quantity
        AND stock.is_available = true
        AND stock.on_hand_quantity > 0
        AND material.rated_outer_length_mm
          = NEW.rated_outer_length_mm
        AND material.rated_outer_width_mm
          = NEW.rated_outer_width_mm
        AND material.rated_outer_height_mm
          = NEW.rated_outer_height_mm
        AND material.tare_weight_grams = NEW.tare_weight_grams
        AND (
          material.max_weight_grams IS NULL
          OR NEW.gross_weight_grams <= material.max_weight_grams
        )
    ) INTO material_ready;
    IF NOT material_ready THEN
      RAISE EXCEPTION
        'Shopify checkout package must use an exact selected material revision';
    END IF;
  ELSIF TG_TABLE_NAME
       = 'operations_shopify_checkout_rate_receipt_offers' THEN
    SELECT EXISTS (
      SELECT 1
      FROM operations_shopify_checkout_rate_receipts receipt
      JOIN operations_shopify_carrier_service_config_carriers selected
        ON selected.organization_id = receipt.organization_id
       AND selected.config_id = receipt.config_id
       AND selected.carrier_provider = NEW.carrier_provider
       AND selected.carrier_account_id = NEW.carrier_account_id
      JOIN operations_carrier_accounts carrier_account
        ON carrier_account.organization_id = selected.organization_id
       AND carrier_account.id = selected.carrier_account_id
      JOIN operations_carrier_rate_requests rate_evidence
        ON rate_evidence.organization_id = receipt.organization_id
       AND rate_evidence.id = NEW.carrier_rate_request_id
       AND rate_evidence.integration_account_id
         = carrier_account.integration_account_id
       AND rate_evidence.provider = NEW.carrier_provider
       AND rate_evidence.purpose = NEW.carrier_rate_purpose
       AND rate_evidence.carrier_account_id = NEW.carrier_account_id
       AND rate_evidence.status = 'succeeded'
       AND rate_evidence.request_hash = NEW.carrier_request_hash
       AND rate_evidence.requested_at >= receipt.created_at
       AND rate_evidence.completed_at
         <= receipt.created_at + interval '30 seconds'
      JOIN operations_carrier_credentials current_credential
        ON current_credential.organization_id
          = carrier_account.organization_id
       AND current_credential.integration_account_id
          = carrier_account.integration_account_id
       AND current_credential.credential_version
          = rate_evidence.credential_version
      WHERE receipt.organization_id = NEW.organization_id
        AND receipt.id = NEW.receipt_id
        AND rate_evidence.redacted_request #>>
          '{shipment,destinationFingerprint}'
          = receipt.carrier_destination_fingerprint
        AND rate_evidence.redacted_request #>>
          '{shipment,rateScope}' = 'multi_package_shipment'
        AND rate_evidence.redacted_request #>
          '{shipment,packageCount}' = (
            SELECT to_jsonb(count(*)::integer)
            FROM operations_shopify_checkout_rate_receipt_packages package
            WHERE package.organization_id = receipt.organization_id
              AND package.receipt_id = receipt.id
          )
        AND rate_evidence.redacted_request #>
          '{shipment,parcels}' = (
            SELECT jsonb_agg(
              package.carrier_parcel_snapshot
              ORDER BY package.package_sequence, package.package_key
            )
            FROM operations_shopify_checkout_rate_receipt_packages package
            WHERE package.organization_id = receipt.organization_id
              AND package.receipt_id = receipt.id
          )
        AND rate_evidence.redacted_response #>>
          '{rateScope}' = 'multi_package_shipment'
        AND rate_evidence.redacted_response #>
          '{packageCount}' = (
            SELECT to_jsonb(count(*)::integer)
            FROM operations_shopify_checkout_rate_receipt_packages package
            WHERE package.organization_id = receipt.organization_id
              AND package.receipt_id = receipt.id
          )
        AND operations_shopify_checkout_carrier_rate_matches(
          rate_evidence.redacted_response,
          NEW.service_code,
          NEW.service_name,
          NEW.carrier_cost_minor,
          NEW.currency,
          NEW.carrier_response_rate_hash
        )
        AND (
          (
            NEW.carrier_provider = 'ups_rest'
            AND NEW.shopify_service_code LIKE 'clawpilot:ups:%'
          )
          OR (
            NEW.carrier_provider = 'fedex_rest'
            AND NEW.shopify_service_code LIKE 'clawpilot:fedex:%'
          )
        )
    ) INTO offer_ready;
    IF NOT offer_ready THEN
      RAISE EXCEPTION
        'Shopify checkout offer requires exact configured carrier and rate evidence';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_checkout_rate_receipt_line_write
  ON operations_shopify_checkout_rate_receipt_lines;
CREATE TRIGGER
  protect_operations_shopify_checkout_rate_receipt_line_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_checkout_rate_receipt_lines
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_shopify_checkout_rate_receipt_child();

DROP TRIGGER IF EXISTS
  protect_operations_shopify_checkout_rate_receipt_package_write
  ON operations_shopify_checkout_rate_receipt_packages;
CREATE TRIGGER
  protect_operations_shopify_checkout_rate_receipt_package_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_checkout_rate_receipt_packages
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_shopify_checkout_rate_receipt_child();

DROP TRIGGER IF EXISTS
  protect_shopify_rate_allocation_write
  ON operations_shopify_checkout_rate_receipt_allocations;
CREATE TRIGGER
  protect_shopify_rate_allocation_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_checkout_rate_receipt_allocations
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_shopify_checkout_rate_receipt_child();

DROP TRIGGER IF EXISTS
  protect_operations_shopify_checkout_rate_receipt_offer_write
  ON operations_shopify_checkout_rate_receipt_offers;
CREATE TRIGGER
  protect_operations_shopify_checkout_rate_receipt_offer_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_checkout_rate_receipt_offers
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_shopify_checkout_rate_receipt_child();

CREATE TABLE IF NOT EXISTS
  operations_shopify_checkout_rate_reconciliations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('gsqc'),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    integration_account_id uuid NOT NULL,
    order_candidate_id uuid NOT NULL,
    receipt_id uuid,
    order_id uuid NOT NULL,
    source_external_order_id text NOT NULL,
    source_order_created_at timestamptz,
    source_line_quantity_fingerprint text CHECK (
      source_line_quantity_fingerprint IS NULL
      OR source_line_quantity_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    source_destination_fingerprint text CHECK (
      source_destination_fingerprint IS NULL
      OR source_destination_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    source_currency text NOT NULL CHECK (
      source_currency ~ '^[A-Z]{3}$'
    ),
    source_shipping_charge_minor bigint CHECK (
      source_shipping_charge_minor IS NULL
      OR source_shipping_charge_minor >= 0
    ),
    source_shopify_service_code text,
    candidate_set_hash text NOT NULL CHECK (
      candidate_set_hash ~ '^[a-f0-9]{64}$'
    ),
    selected_carrier_provider text CHECK (
      selected_carrier_provider IS NULL
      OR selected_carrier_provider IN ('ups_rest', 'fedex_rest')
    ),
    selected_carrier_account_id uuid,
    selected_carrier_rate_request_id uuid,
    selected_service_code text,
    selected_offer_hash text CHECK (
      selected_offer_hash IS NULL
      OR selected_offer_hash ~ '^[a-f0-9]{64}$'
    ),
    selected_customer_charge_minor bigint CHECK (
      selected_customer_charge_minor IS NULL
      OR selected_customer_charge_minor >= 0
    ),
    selected_currency text CHECK (
      selected_currency IS NULL
      OR selected_currency ~ '^[A-Z]{3}$'
    ),
    outcome text NOT NULL CHECK (
      outcome IN ('matched', 'ambiguous', 'rejected', 'expired')
    ),
    match_method text NOT NULL CHECK (
      match_method = 'shopify_exact_rate_v1'
    ),
    candidate_count integer NOT NULL CHECK (candidate_count >= 0),
    match_evidence jsonb NOT NULL,
    idempotency_key text NOT NULL,
    provider_write_count integer NOT NULL DEFAULT 0 CHECK (
      provider_write_count = 0
    ),
    created_by text REFERENCES app_users(email) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT
      operations_shopify_checkout_rate_reconciliations_global_valid
      CHECK (global_id ~ '^gsqc[0-9]{7}$'),
    CONSTRAINT
      operations_shopify_checkout_rate_reconciliations_global_unique
      UNIQUE (global_id),
    CONSTRAINT
      operations_shopify_checkout_rate_reconciliations_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
    CONSTRAINT
      operations_shopify_checkout_rate_reconciliations_account_fkey
      FOREIGN KEY (organization_id, integration_account_id)
      REFERENCES operations_integration_accounts(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT
      operations_shopify_checkout_rate_reconciliations_candidate_fkey
      FOREIGN KEY (organization_id, order_candidate_id)
      REFERENCES operations_commerce_order_candidates(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      operations_shopify_checkout_rate_reconciliations_receipt_fkey
      FOREIGN KEY (organization_id, receipt_id)
      REFERENCES operations_shopify_checkout_rate_receipts(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      operations_shopify_checkout_rate_reconciliations_order_fkey
      FOREIGN KEY (organization_id, order_id)
      REFERENCES operations_orders(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT
      op_shopify_rate_reconciliations_carrier_account_fkey
      FOREIGN KEY (organization_id, selected_carrier_account_id)
      REFERENCES operations_carrier_accounts(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT
      op_shopify_rate_reconciliations_rate_request_fkey
      FOREIGN KEY (organization_id, selected_carrier_rate_request_id)
      REFERENCES operations_carrier_rate_requests(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT
      op_shopify_rate_reconciliations_idempotency_unique
      UNIQUE (organization_id, order_candidate_id, idempotency_key),
    CONSTRAINT
      op_shopify_rate_reconciliations_candidate_unique
      UNIQUE (organization_id, order_candidate_id),
    CONSTRAINT
      operations_shopify_checkout_rate_reconciliations_neutral
      CHECK (
        operations_shopify_checkout_json_is_customer_neutral(
          match_evidence
        )
      ),
    CONSTRAINT
      operations_shopify_checkout_rate_reconciliations_text_valid
      CHECK (
        length(btrim(source_external_order_id)) BETWEEN 1 AND 512
        AND source_external_order_id !~ '[[:cntrl:]]'
        AND (
          source_shopify_service_code IS NULL
          OR source_shopify_service_code
            ~ '^clawpilot:(ups|fedex):[A-Za-z0-9][A-Za-z0-9._-]{0,56}$'
        )
        AND length(btrim(idempotency_key)) BETWEEN 8 AND 200
        AND idempotency_key !~ '[[:cntrl:]]'
      ),
    CONSTRAINT
      operations_shopify_checkout_rate_reconciliations_outcome_valid
      CHECK (
        (
          outcome = 'matched'
          AND receipt_id IS NOT NULL
          AND candidate_count = 1
          AND source_order_created_at IS NOT NULL
          AND source_line_quantity_fingerprint IS NOT NULL
          AND source_destination_fingerprint IS NOT NULL
          AND source_shipping_charge_minor IS NOT NULL
          AND source_shopify_service_code IS NOT NULL
          AND selected_carrier_provider IS NOT NULL
          AND selected_carrier_account_id IS NOT NULL
          AND selected_carrier_rate_request_id IS NOT NULL
          AND length(btrim(selected_service_code)) BETWEEN 1 AND 80
          AND selected_offer_hash IS NOT NULL
          AND selected_customer_charge_minor IS NOT NULL
          AND selected_currency IS NOT NULL
        )
        OR (
          outcome = 'ambiguous'
          AND receipt_id IS NULL
          AND candidate_count >= 2
          AND source_order_created_at IS NOT NULL
          AND source_line_quantity_fingerprint IS NOT NULL
          AND source_destination_fingerprint IS NOT NULL
          AND source_shipping_charge_minor IS NOT NULL
          AND source_shopify_service_code IS NOT NULL
          AND selected_carrier_provider IS NULL
          AND selected_carrier_account_id IS NULL
          AND selected_carrier_rate_request_id IS NULL
          AND selected_service_code IS NULL
          AND selected_offer_hash IS NULL
          AND selected_customer_charge_minor IS NULL
          AND selected_currency IS NULL
        )
        OR (
          outcome IN ('rejected', 'expired')
          AND receipt_id IS NULL
          AND candidate_count = 0
          AND selected_carrier_provider IS NULL
          AND selected_carrier_account_id IS NULL
          AND selected_carrier_rate_request_id IS NULL
          AND selected_service_code IS NULL
          AND selected_offer_hash IS NULL
          AND selected_customer_charge_minor IS NULL
          AND selected_currency IS NULL
        )
      )
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  op_shopify_rate_reconciliations_receipt_match_unique
  ON operations_shopify_checkout_rate_reconciliations (
    organization_id, receipt_id
  )
  WHERE outcome = 'matched';

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_rate_match_candidates(
    requested_organization_id uuid,
    requested_order_candidate_id uuid,
    enforce_reconciliation_deadline boolean DEFAULT true
  )
RETURNS TABLE (
  receipt_id uuid,
  receipt_global_id text,
  offer_carrier_provider text,
  offer_carrier_account_id uuid,
  offer_carrier_rate_request_id uuid,
  offer_service_code text,
  offer_shopify_service_code text,
  offer_hash text,
  offer_customer_charge_minor bigint,
  offer_currency text
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    receipt.id,
    receipt.global_id,
    offer.carrier_provider,
    offer.carrier_account_id,
    offer.carrier_rate_request_id,
    offer.service_code,
    offer.shopify_service_code,
    offer.offer_hash,
    offer.customer_charge_minor,
    offer.currency
  FROM operations_commerce_order_candidates candidate
  JOIN operations_shopify_checkout_rate_receipts receipt
    ON receipt.organization_id = candidate.organization_id
   AND receipt.integration_account_id = candidate.integration_account_id
   AND receipt.status = 'succeeded'
   AND receipt.destination_fingerprint
     = candidate.checkout_destination_fingerprint
   AND receipt.line_quantity_fingerprint
     = operations_shopify_checkout_order_line_quantity_fingerprint(
       candidate.organization_id,
       candidate.id
     )
   AND receipt.currency = candidate.currency_code
   AND (
     NOT enforce_reconciliation_deadline
     OR (
       candidate.provider_created_at
         >= date_trunc('second', receipt.created_at)
       AND candidate.provider_created_at
         <= receipt.reconciliation_deadline_at
     )
   )
  JOIN operations_shopify_checkout_rate_receipt_offers offer
    ON offer.organization_id = receipt.organization_id
   AND offer.receipt_id = receipt.id
   AND offer.shopify_service_code
     = candidate.checkout_shipping_service_code
   AND offer.customer_charge_minor = candidate.shipping_minor
   AND offer.currency = candidate.currency_code
  WHERE candidate.organization_id = requested_organization_id
    AND candidate.id = requested_order_candidate_id
    AND candidate.provider = 'shopify'
    AND candidate.workflow_state = 'promoted'
    AND candidate.canonical_order_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM operations_shopify_checkout_rate_reconciliations prior
      WHERE prior.organization_id = receipt.organization_id
        AND prior.receipt_id = receipt.id
        AND prior.outcome = 'matched'
    )
  ORDER BY receipt.global_id, offer.offer_hash;
$$;

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_checkout_rate_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_candidate operations_commerce_order_candidates%ROWTYPE;
  exact_candidate_count integer;
  potential_candidate_count integer;
  exact_candidate_set_hash text;
  selected_match record;
  computed_line_quantity_fingerprint text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify checkout rate reconciliation evidence is immutable';
  END IF;

  SELECT * INTO source_candidate
  FROM operations_commerce_order_candidates candidate
  WHERE candidate.organization_id = NEW.organization_id
    AND candidate.id = NEW.order_candidate_id;
  IF NOT FOUND
     OR source_candidate.provider IS DISTINCT FROM 'shopify'
     OR source_candidate.workflow_state IS DISTINCT FROM 'promoted'
     OR source_candidate.canonical_order_id IS NULL
     OR source_candidate.canonical_order_id IS DISTINCT FROM NEW.order_id
     OR source_candidate.integration_account_id
       IS DISTINCT FROM NEW.integration_account_id
  THEN
    RAISE EXCEPTION
      'Shopify reconciliation requires one promoted typed order candidate';
  END IF;

  computed_line_quantity_fingerprint :=
    operations_shopify_checkout_order_line_quantity_fingerprint(
      NEW.organization_id,
      NEW.order_candidate_id
    );
  IF NEW.source_external_order_id
       IS DISTINCT FROM source_candidate.external_order_id
     OR NEW.source_order_created_at
       IS DISTINCT FROM source_candidate.provider_created_at
     OR NEW.source_line_quantity_fingerprint
       IS DISTINCT FROM computed_line_quantity_fingerprint
     OR NEW.source_destination_fingerprint
       IS DISTINCT FROM source_candidate.checkout_destination_fingerprint
     OR NEW.source_currency IS DISTINCT FROM source_candidate.currency_code
     OR NEW.source_shipping_charge_minor
       IS DISTINCT FROM source_candidate.shipping_minor
     OR NEW.source_shopify_service_code
       IS DISTINCT FROM source_candidate.checkout_shipping_service_code
  THEN
    RAISE EXCEPTION
      'Shopify reconciliation source evidence must equal the typed order';
  END IF;

  SELECT
    count(*)::integer,
    encode(
      digest(
        COALESCE(
          string_agg(
            receipt_global_id || ':' || offer_hash,
            E'\n'
            ORDER BY receipt_global_id, offer_hash
          ),
          ''
        ),
        'sha256'
      ),
      'hex'
    )
    INTO exact_candidate_count, exact_candidate_set_hash
  FROM operations_shopify_checkout_rate_match_candidates(
    NEW.organization_id,
    NEW.order_candidate_id,
    true
  );
  SELECT count(*)::integer INTO potential_candidate_count
  FROM operations_shopify_checkout_rate_match_candidates(
    NEW.organization_id,
    NEW.order_candidate_id,
    false
  );

  IF NEW.candidate_count IS DISTINCT FROM exact_candidate_count
     OR NEW.candidate_set_hash IS DISTINCT FROM exact_candidate_set_hash
  THEN
    RAISE EXCEPTION
      'Shopify reconciliation candidate evidence was not database-derived';
  END IF;

  IF exact_candidate_count = 1 THEN
    SELECT * INTO selected_match
    FROM operations_shopify_checkout_rate_match_candidates(
      NEW.organization_id,
      NEW.order_candidate_id,
      true
    );
    IF NEW.outcome IS DISTINCT FROM 'matched'
       OR NEW.receipt_id IS DISTINCT FROM selected_match.receipt_id
       OR NEW.selected_carrier_provider
         IS DISTINCT FROM selected_match.offer_carrier_provider
       OR NEW.selected_carrier_account_id
         IS DISTINCT FROM selected_match.offer_carrier_account_id
       OR NEW.selected_carrier_rate_request_id
         IS DISTINCT FROM selected_match.offer_carrier_rate_request_id
       OR NEW.selected_service_code
         IS DISTINCT FROM selected_match.offer_service_code
       OR NEW.selected_offer_hash
         IS DISTINCT FROM selected_match.offer_hash
       OR NEW.selected_customer_charge_minor
         IS DISTINCT FROM selected_match.offer_customer_charge_minor
       OR NEW.selected_currency
         IS DISTINCT FROM selected_match.offer_currency
    THEN
      RAISE EXCEPTION
        'Shopify exact match must retain the exact typed checkout offer';
    END IF;
  ELSIF exact_candidate_count > 1 THEN
    IF NEW.outcome IS DISTINCT FROM 'ambiguous'
       OR NEW.receipt_id IS NOT NULL
    THEN
      RAISE EXCEPTION
        'Ambiguous Shopify checkout matches fail closed';
    END IF;
  ELSE
    IF NEW.outcome IS DISTINCT FROM (
         CASE
           WHEN potential_candidate_count > 0 THEN 'expired'
           ELSE 'rejected'
         END
       )
       OR NEW.receipt_id IS NOT NULL
    THEN
      RAISE EXCEPTION
        'Unmatched Shopify checkout decisions fail closed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_checkout_rate_reconciliation_write
  ON operations_shopify_checkout_rate_reconciliations;
CREATE TRIGGER
  protect_operations_shopify_checkout_rate_reconciliation_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_checkout_rate_reconciliations
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_shopify_checkout_rate_reconciliation();

COMMENT ON TABLE operations_shopify_carrier_service_configs IS
  'One revision-fenced Shopify CarrierService policy per commerce account. Provider registration is exact-Active fenced; an already registered read-only callback may remain eligible in current Shadow. Ready states also require verified current credentials, an active warehouse, 1-8 stocked materials with evidenced rated outside dimensions, and active same-environment UPS plus FedEx accounts.';
COMMENT ON TABLE operations_shopify_checkout_rate_receipts IS
  'Immutable and idempotent customer-neutral Shopify callback evidence fenced by configuration, actual activation mode/revision, inventory snapshot hash/freshness, and policy. Destination details are retained only as a fingerprint and callback processing performs zero provider writes.';
COMMENT ON TABLE operations_shopify_checkout_rate_reconciliations IS
  'Append-only later-order reconciliation decisions. Ambiguous matches remain unresolved and never fabricate an order link.';
