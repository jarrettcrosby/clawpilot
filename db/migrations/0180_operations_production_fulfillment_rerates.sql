-- Append-only production fulfillment rerating and selection evidence.
--
-- Checkout and Shadow carrier evidence remain unchanged. Production rerating
-- starts only from one exact 0179 Active execution/package set. Provider
-- attempts are committed before network I/O, terminal results are appended
-- separately, and dispatch may reference only one unexpired immutable
-- selection. The selected production service may differ from the inherited
-- Shadow planning estimate retained on operations_active_shipment_groups.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM operations_active_carrier_group_attempts LIMIT 1
  ) THEN
    RAISE EXCEPTION
      'Migration 0180 cannot safely bind existing Active carrier dispatch attempts to production rerate selections';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM global_reference_entity_types entity_type
    WHERE entity_type.prefix IN (
      'gafr', 'garp', 'gara', 'garr', 'garo', 'gars'
    )
      AND (entity_type.prefix, entity_type.entity_type) NOT IN (
        ('gafr', 'operations.production_fulfillment_rerate_run'),
        ('garp', 'operations.production_fulfillment_rerate_package'),
        ('gara', 'operations.production_fulfillment_rerate_attempt'),
        ('garr', 'operations.production_fulfillment_rerate_result'),
        ('garo', 'operations.production_fulfillment_rerate_offer'),
        ('gars', 'operations.production_fulfillment_rerate_selection')
      )
  ) THEN
    RAISE EXCEPTION
      'Migration 0180 Global ID prefix is already owned by another entity type';
  END IF;
END;
$$;

INSERT INTO global_reference_entity_types (
  prefix, entity_type, display_name
)
VALUES
  (
    'gafr',
    'operations.production_fulfillment_rerate_run',
    'Production fulfillment rerate run'
  ),
  (
    'garp',
    'operations.production_fulfillment_rerate_package',
    'Production fulfillment rerate package'
  ),
  (
    'gara',
    'operations.production_fulfillment_rerate_attempt',
    'Production fulfillment rerate attempt'
  ),
  (
    'garr',
    'operations.production_fulfillment_rerate_result',
    'Production fulfillment rerate result'
  ),
  (
    'garo',
    'operations.production_fulfillment_rerate_offer',
    'Production fulfillment rerate offer'
  ),
  (
    'gars',
    'operations.production_fulfillment_rerate_selection',
    'Production fulfillment rerate selection'
  )
ON CONFLICT (prefix) DO NOTHING;

-- Carrier-account mutations that can affect provider requests advance one
-- database-managed configuration revision. Immutable account-number identity
-- remains protected by migration 0092.
ALTER TABLE operations_carrier_accounts
  ADD COLUMN IF NOT EXISTS configuration_revision integer NOT NULL DEFAULT 1;

ALTER TABLE operations_carrier_accounts
  ADD CONSTRAINT operations_carrier_accounts_configuration_revision_valid
    CHECK (configuration_revision >= 1);

CREATE OR REPLACE FUNCTION
  manage_operations_carrier_account_configuration_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  configuration_changed boolean;
BEGIN
  configuration_changed := ROW(
    NEW.display_name,
    NEW.registered_address,
    NEW.registered_address_fingerprint,
    NEW.address_verification,
    NEW.allow_sender_billing,
    NEW.allow_recipient_billing,
    NEW.allow_third_party_billing,
    NEW.status,
    NEW.sender_name
  ) IS DISTINCT FROM ROW(
    OLD.display_name,
    OLD.registered_address,
    OLD.registered_address_fingerprint,
    OLD.address_verification,
    OLD.allow_sender_billing,
    OLD.allow_recipient_billing,
    OLD.allow_third_party_billing,
    OLD.status,
    OLD.sender_name
  );

  IF configuration_changed THEN
    IF NEW.configuration_revision NOT IN (
      OLD.configuration_revision,
      OLD.configuration_revision + 1
    ) THEN
      RAISE EXCEPTION
        'Carrier account configuration revision must advance exactly once';
    END IF;
    NEW.configuration_revision := OLD.configuration_revision + 1;
  ELSIF NEW.configuration_revision IS DISTINCT FROM OLD.configuration_revision
  THEN
    RAISE EXCEPTION
      'Carrier account configuration revision cannot change without a configuration change';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  manage_operations_carrier_account_configuration_revision_trigger
  ON operations_carrier_accounts;
CREATE TRIGGER
  manage_operations_carrier_account_configuration_revision_trigger
BEFORE UPDATE ON operations_carrier_accounts
FOR EACH ROW EXECUTE FUNCTION
  manage_operations_carrier_account_configuration_revision();

-- The credential fingerprint is derived inside PostgreSQL from the encrypted
-- bytes and their monotonic credential_version. It contains no plaintext or
-- reusable provider secret.
CREATE OR REPLACE FUNCTION operations_carrier_credential_fingerprint(
  input_version integer,
  input_ciphertext bytea,
  input_iv bytea,
  input_tag bytea
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT encode(
    digest(
      int4send(input_version)
        || input_ciphertext
        || input_iv
        || input_tag,
      'sha256'
    ),
    'hex'
  )
$$;

ALTER TABLE operations_carrier_credentials
  ADD COLUMN IF NOT EXISTS credential_fingerprint text;

UPDATE operations_carrier_credentials
SET credential_fingerprint = operations_carrier_credential_fingerprint(
  credential_version,
  credential_ciphertext,
  credential_iv,
  credential_tag
)
WHERE credential_fingerprint IS NULL;

ALTER TABLE operations_carrier_credentials
  ALTER COLUMN credential_fingerprint SET NOT NULL,
  ADD CONSTRAINT operations_carrier_credentials_fingerprint_valid CHECK (
    credential_fingerprint ~ '^[a-f0-9]{64}$'
  );

CREATE OR REPLACE FUNCTION
  manage_operations_carrier_credential_fingerprint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  secret_changed boolean;
  expected_fingerprint text;
BEGIN
  expected_fingerprint := operations_carrier_credential_fingerprint(
    NEW.credential_version,
    NEW.credential_ciphertext,
    NEW.credential_iv,
    NEW.credential_tag
  );

  IF TG_OP = 'UPDATE' THEN
    secret_changed := ROW(
      NEW.credential_ciphertext,
      NEW.credential_iv,
      NEW.credential_tag
    ) IS DISTINCT FROM ROW(
      OLD.credential_ciphertext,
      OLD.credential_iv,
      OLD.credential_tag
    );
    IF secret_changed
       AND NEW.credential_version <> OLD.credential_version + 1
    THEN
      RAISE EXCEPTION
        'Carrier credential rotation must advance credential_version exactly once';
    END IF;
    IF NOT secret_changed
       AND NEW.credential_version IS DISTINCT FROM OLD.credential_version
    THEN
      RAISE EXCEPTION
        'Carrier credential_version cannot change without new encrypted credential bytes';
    END IF;
  END IF;

  IF NEW.credential_fingerprint IS NOT NULL
     AND NEW.credential_fingerprint IS DISTINCT FROM expected_fingerprint
  THEN
    RAISE EXCEPTION
      'Carrier credential fingerprint is database-derived and cannot be supplied incorrectly';
  END IF;
  NEW.credential_fingerprint := expected_fingerprint;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  manage_operations_carrier_credential_fingerprint_trigger
  ON operations_carrier_credentials;
CREATE TRIGGER
  manage_operations_carrier_credential_fingerprint_trigger
BEFORE INSERT OR UPDATE ON operations_carrier_credentials
FOR EACH ROW EXECUTE FUNCTION
  manage_operations_carrier_credential_fingerprint();

-- Production carrier evidence has a narrower secret surface than generic
-- commerce effects. In addition to tokens and secrets, reject raw carrier
-- account numbers and every encrypted credential/account-number component.
-- The recursive walk and one-MiB bound also keep persisted diagnostics safe
-- and operationally reviewable.
CREATE OR REPLACE FUNCTION
  operations_production_rerate_json_is_redacted(value jsonb)
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
        'accountnumber',
        'payeraccountnumber',
        'credentialciphertext',
        'credentialiv',
        'credentialtag',
        'accountnumberciphertext',
        'accountnumberiv',
        'accountnumbertag'
      )
    )
$$;

CREATE TABLE IF NOT EXISTS
  operations_production_fulfillment_rerate_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('gafr'),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    active_fulfillment_execution_id uuid NOT NULL,
    active_shipment_group_id uuid NOT NULL,
    order_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    source_fulfillment_pack_rate_run_id uuid NOT NULL,
    activation_revision integer NOT NULL CHECK (activation_revision >= 1),
    purpose text NOT NULL DEFAULT 'fulfillment_execution' CHECK (
      purpose = 'fulfillment_execution'
    ),
    environment text NOT NULL DEFAULT 'production' CHECK (
      environment = 'production'
    ),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
    destination_snapshot jsonb NOT NULL CHECK (
      jsonb_typeof(destination_snapshot) = 'object'
    ),
    destination_fingerprint text NOT NULL CHECK (
      destination_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    ordered_package_set_fingerprint text NOT NULL CHECK (
      ordered_package_set_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    package_count integer NOT NULL CHECK (package_count BETWEEN 1 AND 50),
    idempotency_key text NOT NULL,
    actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
    prepared_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operations_production_rerate_runs_global_valid CHECK (
      global_id ~ '^gafr[0-9]{7}$'
    ),
    CONSTRAINT operations_production_rerate_runs_global_unique
      UNIQUE (global_id),
    CONSTRAINT operations_production_rerate_runs_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_runs_active_group_fkey
      FOREIGN KEY (
        organization_id, active_fulfillment_execution_id,
        active_shipment_group_id
      )
      REFERENCES operations_active_shipment_groups(
        organization_id, active_fulfillment_execution_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_runs_order_fkey
      FOREIGN KEY (organization_id, order_id)
      REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_runs_plan_fkey
      FOREIGN KEY (organization_id, plan_id)
      REFERENCES operations_fulfillment_plans(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_runs_warehouse_fkey
      FOREIGN KEY (organization_id, warehouse_id)
      REFERENCES operations_warehouses(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_runs_source_run_fkey
      FOREIGN KEY (organization_id, source_fulfillment_pack_rate_run_id)
      REFERENCES operations_pack_rate_runs(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_runs_org_id_unique
      UNIQUE (organization_id, id),
    CONSTRAINT operations_production_rerate_runs_lineage_unique
      UNIQUE (
        organization_id, id, active_fulfillment_execution_id,
        active_shipment_group_id
      ),
    CONSTRAINT operations_production_rerate_runs_idempotency_unique
      UNIQUE (organization_id, idempotency_key),
    CONSTRAINT operations_production_rerate_runs_text_valid CHECK (
      length(btrim(idempotency_key)) BETWEEN 8 AND 200
      AND idempotency_key !~ '[[:cntrl:]]'
    )
  );

CREATE INDEX IF NOT EXISTS operations_production_rerate_runs_group_idx
  ON operations_production_fulfillment_rerate_runs (
    organization_id, active_shipment_group_id, prepared_at DESC, id
  );

CREATE TABLE IF NOT EXISTS
  operations_production_fulfillment_rerate_packages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('garp'),
    organization_id uuid NOT NULL,
    rerate_run_id uuid NOT NULL,
    active_fulfillment_execution_id uuid NOT NULL,
    active_shipment_group_id uuid NOT NULL,
    package_id uuid NOT NULL,
    package_global_id text NOT NULL,
    package_key text NOT NULL,
    package_number integer NOT NULL CHECK (package_number > 0),
    length_mm integer NOT NULL CHECK (length_mm > 0),
    width_mm integer NOT NULL CHECK (width_mm > 0),
    height_mm integer NOT NULL CHECK (height_mm > 0),
    weight_grams integer NOT NULL CHECK (weight_grams > 0),
    package_hash text NOT NULL CHECK (package_hash ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operations_production_rerate_packages_global_valid CHECK (
      global_id ~ '^garp[0-9]{7}$'
    ),
    CONSTRAINT operations_production_rerate_packages_global_unique
      UNIQUE (global_id),
    CONSTRAINT operations_production_rerate_packages_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_packages_run_lineage_fkey
      FOREIGN KEY (
        organization_id, rerate_run_id,
        active_fulfillment_execution_id, active_shipment_group_id
      )
      REFERENCES operations_production_fulfillment_rerate_runs(
        organization_id, id,
        active_fulfillment_execution_id, active_shipment_group_id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_packages_active_package_fkey
      FOREIGN KEY (
        organization_id, active_fulfillment_execution_id,
        active_shipment_group_id, package_id
      )
      REFERENCES operations_active_execution_packages(
        organization_id, active_fulfillment_execution_id,
        active_shipment_group_id, package_id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_packages_package_fkey
      FOREIGN KEY (organization_id, package_id)
      REFERENCES operations_packages(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_packages_org_id_unique
      UNIQUE (organization_id, id),
    CONSTRAINT operations_production_rerate_packages_run_package_unique
      UNIQUE (organization_id, rerate_run_id, package_id),
    CONSTRAINT operations_production_rerate_packages_run_number_unique
      UNIQUE (organization_id, rerate_run_id, package_number),
    CONSTRAINT operations_production_rerate_packages_text_valid CHECK (
      package_global_id ~ '^gpa[0-9]{7}$'
      AND length(btrim(package_key)) BETWEEN 1 AND 160
      AND package_key !~ '[[:cntrl:]]'
    )
  );

CREATE TABLE IF NOT EXISTS
  operations_production_fulfillment_rerate_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('gara'),
    organization_id uuid NOT NULL,
    rerate_run_id uuid NOT NULL,
    attempt_number integer NOT NULL CHECK (attempt_number >= 1),
    state text NOT NULL DEFAULT 'prepared' CHECK (state = 'prepared'),
    provider text NOT NULL CHECK (provider IN ('ups_rest', 'fedex_rest')),
    environment text NOT NULL DEFAULT 'production' CHECK (
      environment = 'production'
    ),
    integration_account_id uuid NOT NULL,
    carrier_account_id uuid NOT NULL,
    carrier_account_configuration_revision integer NOT NULL CHECK (
      carrier_account_configuration_revision >= 1
    ),
    account_number_fingerprint text NOT NULL CHECK (
      account_number_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    registered_origin_fingerprint text NOT NULL CHECK (
      registered_origin_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    credential_revision integer NOT NULL CHECK (credential_revision >= 1),
    credential_fingerprint text NOT NULL CHECK (
      credential_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    sender_name_snapshot text NOT NULL,
    origin_snapshot jsonb NOT NULL CHECK (
      jsonb_typeof(origin_snapshot) = 'object'
    ),
    origin_fingerprint text NOT NULL CHECK (
      origin_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    billing_relationship text NOT NULL CHECK (
      billing_relationship IN ('sender', 'recipient', 'third_party')
    ),
    payer_account_number_fingerprint text NOT NULL CHECK (
      payer_account_number_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    payer_country_code text NOT NULL CHECK (
      payer_country_code ~ '^[A-Z]{2}$'
    ),
    payer_postal_code text NOT NULL,
    billing_snapshot jsonb NOT NULL CHECK (
      jsonb_typeof(billing_snapshot) = 'object'
    ),
    billing_fingerprint text NOT NULL CHECK (
      billing_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    adapter_version text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    redacted_request jsonb NOT NULL CHECK (
      operations_production_rerate_json_is_redacted(redacted_request)
    ),
    actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
    persisted_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operations_production_rerate_attempts_global_valid CHECK (
      global_id ~ '^gara[0-9]{7}$'
    ),
    CONSTRAINT operations_production_rerate_attempts_global_unique
      UNIQUE (global_id),
    CONSTRAINT operations_production_rerate_attempts_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_attempts_run_fkey
      FOREIGN KEY (organization_id, rerate_run_id)
      REFERENCES operations_production_fulfillment_rerate_runs(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_attempts_account_fkey
      FOREIGN KEY (
        organization_id, integration_account_id, carrier_account_id
      )
      REFERENCES operations_carrier_accounts(
        organization_id, integration_account_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_attempts_credential_fkey
      FOREIGN KEY (organization_id, integration_account_id)
      REFERENCES operations_carrier_credentials(
        organization_id, integration_account_id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_attempts_org_id_unique
      UNIQUE (organization_id, id),
    CONSTRAINT operations_production_rerate_attempts_lineage_unique
      UNIQUE (organization_id, id, rerate_run_id),
    CONSTRAINT operations_production_rerate_attempts_number_unique
      UNIQUE (
        organization_id, rerate_run_id, provider, attempt_number
      ),
    CONSTRAINT operations_production_rerate_attempts_idempotency_unique
      UNIQUE (organization_id, idempotency_key),
    CONSTRAINT operations_production_rerate_attempts_text_valid CHECK (
      length(btrim(sender_name_snapshot)) BETWEEN 1 AND 120
      AND sender_name_snapshot !~ '[[:cntrl:]]'
      AND length(btrim(payer_postal_code)) BETWEEN 1 AND 32
      AND payer_postal_code !~ '[[:cntrl:]]'
      AND length(btrim(adapter_version)) BETWEEN 1 AND 128
      AND adapter_version !~ '[[:cntrl:]]'
      AND length(btrim(idempotency_key)) BETWEEN 8 AND 200
      AND idempotency_key !~ '[[:cntrl:]]'
    )
  );

CREATE INDEX IF NOT EXISTS operations_production_rerate_attempts_run_idx
  ON operations_production_fulfillment_rerate_attempts (
    organization_id, rerate_run_id, provider, attempt_number DESC
  );

CREATE TABLE IF NOT EXISTS
  operations_production_fulfillment_rerate_results (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('garr'),
    organization_id uuid NOT NULL,
    rerate_run_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    state text NOT NULL CHECK (
      state IN ('succeeded', 'failed', 'unknown')
    ),
    provider_reference text,
    error_code text,
    result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    redacted_response jsonb NOT NULL CHECK (
      operations_production_rerate_json_is_redacted(redacted_response)
    ),
    completed_at timestamptz NOT NULL,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operations_production_rerate_results_global_valid CHECK (
      global_id ~ '^garr[0-9]{7}$'
    ),
    CONSTRAINT operations_production_rerate_results_global_unique
      UNIQUE (global_id),
    CONSTRAINT operations_production_rerate_results_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_results_attempt_fkey
      FOREIGN KEY (organization_id, attempt_id, rerate_run_id)
      REFERENCES operations_production_fulfillment_rerate_attempts(
        organization_id, id, rerate_run_id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_results_org_id_unique
      UNIQUE (organization_id, id),
    CONSTRAINT operations_production_rerate_results_lineage_unique
      UNIQUE (organization_id, id, rerate_run_id, attempt_id),
    CONSTRAINT operations_production_rerate_results_attempt_unique
      UNIQUE (organization_id, attempt_id),
    CONSTRAINT operations_production_rerate_results_state_valid CHECK (
      (
        state = 'succeeded'
        AND provider_reference IS NOT NULL
        AND error_code IS NULL
        AND expires_at IS NOT NULL
        AND expires_at > completed_at
        AND expires_at <= completed_at + interval '15 minutes'
      )
      OR (
        state IN ('failed', 'unknown')
        AND error_code IS NOT NULL
        AND expires_at IS NULL
      )
    ),
    CONSTRAINT operations_production_rerate_results_text_valid CHECK (
      (provider_reference IS NULL OR (
        length(btrim(provider_reference)) BETWEEN 1 AND 200
        AND provider_reference !~ '[[:cntrl:]]'
      ))
      AND (error_code IS NULL OR (
        length(btrim(error_code)) BETWEEN 3 AND 128
        AND error_code ~ '^[A-Z0-9_]+$'
      ))
    )
  );

CREATE TABLE IF NOT EXISTS
  operations_production_fulfillment_rerate_offers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('garo'),
    organization_id uuid NOT NULL,
    rerate_run_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    result_id uuid NOT NULL,
    provider text NOT NULL CHECK (provider IN ('ups_rest', 'fedex_rest')),
    service_code text NOT NULL,
    service_name text NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    transit_days integer CHECK (transit_days IS NULL OR transit_days >= 0),
    delivery_at timestamptz,
    offer_hash text NOT NULL CHECK (offer_hash ~ '^[a-f0-9]{64}$'),
    normalized_offer jsonb NOT NULL CHECK (
      jsonb_typeof(normalized_offer) = 'object'
    ),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operations_production_rerate_offers_global_valid CHECK (
      global_id ~ '^garo[0-9]{7}$'
    ),
    CONSTRAINT operations_production_rerate_offers_global_unique
      UNIQUE (global_id),
    CONSTRAINT operations_production_rerate_offers_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_offers_result_fkey
      FOREIGN KEY (
        organization_id, result_id, rerate_run_id, attempt_id
      )
      REFERENCES operations_production_fulfillment_rerate_results(
        organization_id, id, rerate_run_id, attempt_id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_offers_org_id_unique
      UNIQUE (organization_id, id),
    CONSTRAINT operations_production_rerate_offers_lineage_unique
      UNIQUE (
        organization_id, id, rerate_run_id, attempt_id, result_id
      ),
    CONSTRAINT operations_production_rerate_offers_service_unique
      UNIQUE (organization_id, result_id, service_code),
    CONSTRAINT operations_production_rerate_offers_text_valid CHECK (
      length(btrim(service_code)) BETWEEN 1 AND 80
      AND service_code !~ '[[:cntrl:]]'
      AND length(btrim(service_name)) BETWEEN 1 AND 160
      AND service_name !~ '[[:cntrl:]]'
    )
  );

CREATE TABLE IF NOT EXISTS
  operations_production_fulfillment_rerate_selections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('gars'),
    organization_id uuid NOT NULL,
    rerate_run_id uuid NOT NULL,
    active_fulfillment_execution_id uuid NOT NULL,
    active_shipment_group_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    result_id uuid NOT NULL,
    offer_id uuid NOT NULL,
    provider text NOT NULL CHECK (provider IN ('ups_rest', 'fedex_rest')),
    service_code text NOT NULL,
    service_name text NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    integration_account_id uuid NOT NULL,
    carrier_account_id uuid NOT NULL,
    carrier_account_configuration_revision integer NOT NULL CHECK (
      carrier_account_configuration_revision >= 1
    ),
    account_number_fingerprint text NOT NULL CHECK (
      account_number_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    registered_origin_fingerprint text NOT NULL CHECK (
      registered_origin_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    credential_revision integer NOT NULL CHECK (credential_revision >= 1),
    credential_fingerprint text NOT NULL CHECK (
      credential_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    adapter_version text NOT NULL,
    provider_reference text NOT NULL,
    input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
    result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    origin_fingerprint text NOT NULL CHECK (
      origin_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    destination_fingerprint text NOT NULL CHECK (
      destination_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    billing_fingerprint text NOT NULL CHECK (
      billing_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    ordered_package_set_fingerprint text NOT NULL CHECK (
      ordered_package_set_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    expires_at timestamptz NOT NULL,
    selection_reason text NOT NULL,
    selected_by text REFERENCES app_users(email) ON DELETE SET NULL,
    selected_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operations_production_rerate_selections_global_valid CHECK (
      global_id ~ '^gars[0-9]{7}$'
    ),
    CONSTRAINT operations_production_rerate_selections_global_unique
      UNIQUE (global_id),
    CONSTRAINT operations_production_rerate_selections_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_selections_run_lineage_fkey
      FOREIGN KEY (
        organization_id, rerate_run_id,
        active_fulfillment_execution_id, active_shipment_group_id
      )
      REFERENCES operations_production_fulfillment_rerate_runs(
        organization_id, id,
        active_fulfillment_execution_id, active_shipment_group_id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_selections_offer_fkey
      FOREIGN KEY (
        organization_id, offer_id, rerate_run_id,
        attempt_id, result_id
      )
      REFERENCES operations_production_fulfillment_rerate_offers(
        organization_id, id, rerate_run_id,
        attempt_id, result_id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_production_rerate_selections_org_id_unique
      UNIQUE (organization_id, id),
    CONSTRAINT operations_production_rerate_selections_dispatch_fkey_target
      UNIQUE (
        organization_id, id, active_fulfillment_execution_id,
        active_shipment_group_id
      ),
    CONSTRAINT operations_production_rerate_selections_run_unique
      UNIQUE (organization_id, rerate_run_id),
    CONSTRAINT operations_production_rerate_selections_ttl_valid CHECK (
      expires_at > selected_at
      AND expires_at <= selected_at + interval '15 minutes'
    ),
    CONSTRAINT operations_production_rerate_selections_text_valid CHECK (
      length(btrim(service_code)) BETWEEN 1 AND 80
      AND service_code !~ '[[:cntrl:]]'
      AND length(btrim(service_name)) BETWEEN 1 AND 160
      AND service_name !~ '[[:cntrl:]]'
      AND length(btrim(adapter_version)) BETWEEN 1 AND 128
      AND adapter_version !~ '[[:cntrl:]]'
      AND length(btrim(provider_reference)) BETWEEN 1 AND 200
      AND provider_reference !~ '[[:cntrl:]]'
      AND length(btrim(selection_reason)) BETWEEN 3 AND 500
      AND selection_reason !~ '[[:cntrl:]]'
    )
  );

-- Every table above is append-only. Prepared provider attempts and terminal
-- results are separate rows so no network outcome mutates the durable request.
CREATE TRIGGER protect_operations_production_rerate_runs_mutation
BEFORE UPDATE OR DELETE
ON operations_production_fulfillment_rerate_runs
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

CREATE TRIGGER protect_operations_production_rerate_packages_mutation
BEFORE UPDATE OR DELETE
ON operations_production_fulfillment_rerate_packages
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

CREATE TRIGGER protect_operations_production_rerate_attempts_mutation
BEFORE UPDATE OR DELETE
ON operations_production_fulfillment_rerate_attempts
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

CREATE TRIGGER protect_operations_production_rerate_results_mutation
BEFORE UPDATE OR DELETE
ON operations_production_fulfillment_rerate_results
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

CREATE TRIGGER protect_operations_production_rerate_offers_mutation
BEFORE UPDATE OR DELETE
ON operations_production_fulfillment_rerate_offers
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

CREATE TRIGGER protect_operations_production_rerate_selections_mutation
BEFORE UPDATE OR DELETE
ON operations_production_fulfillment_rerate_selections
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

-- Provider dispatch snapshots may include contact/company/phone/email and
-- residential facts that are not present on the canonical order/account core
-- address. Bind the shared shipping fields without requiring the two JSON
-- documents to have identical enrichment keys.
CREATE OR REPLACE FUNCTION operations_dispatch_address_matches_core(
  dispatch_address jsonb,
  core_address jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT jsonb_typeof(dispatch_address) = 'object'
    AND jsonb_typeof(core_address) = 'object'
    AND NULLIF(btrim(dispatch_address->>'line1'), '')
      IS NOT DISTINCT FROM NULLIF(btrim(core_address->>'line1'), '')
    AND COALESCE(NULLIF(btrim(dispatch_address->>'line2'), ''), '')
      IS NOT DISTINCT FROM
      COALESCE(NULLIF(btrim(core_address->>'line2'), ''), '')
    AND NULLIF(btrim(dispatch_address->>'city'), '')
      IS NOT DISTINCT FROM NULLIF(btrim(core_address->>'city'), '')
    AND COALESCE(NULLIF(btrim(dispatch_address->>'region'), ''), '')
      IS NOT DISTINCT FROM
      COALESCE(NULLIF(btrim(core_address->>'region'), ''), '')
    AND upper(NULLIF(btrim(dispatch_address->>'postalCode'), ''))
      IS NOT DISTINCT FROM upper(NULLIF(btrim(core_address->>'postalCode'), ''))
    AND upper(NULLIF(btrim(dispatch_address->>'countryCode'), ''))
      IS NOT DISTINCT FROM upper(NULLIF(btrim(COALESCE(
        core_address->>'countryCode',
        core_address->>'country'
      )), ''))
    AND (
      NULLIF(btrim(COALESCE(
        core_address->>'name',
        core_address->>'contactName'
      )), '') IS NULL
      OR NULLIF(btrim(dispatch_address->>'contactName'), '')
        IS NOT DISTINCT FROM NULLIF(btrim(COALESCE(
          core_address->>'name',
          core_address->>'contactName'
        )), '')
    )
$$;

CREATE OR REPLACE FUNCTION
  validate_operations_production_rerate_run_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  activation_state text;
  current_activation_revision integer;
  active_execution operations_active_fulfillment_executions%ROWTYPE;
  active_group operations_active_shipment_groups%ROWTYPE;
  shadow_execution operations_fulfillment_executions%ROWTYPE;
  source_run operations_pack_rate_runs%ROWTYPE;
  current_order operations_orders%ROWTYPE;
BEGIN
  SELECT activation.state, activation.revision
    INTO activation_state, current_activation_revision
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id
  FOR SHARE;
  IF activation_state IS DISTINCT FROM 'active'
     OR current_activation_revision IS DISTINCT FROM NEW.activation_revision
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate requires the current Operations Active revision';
  END IF;

  SELECT * INTO active_execution
  FROM operations_active_fulfillment_executions execution
  WHERE execution.organization_id = NEW.organization_id
    AND execution.id = NEW.active_fulfillment_execution_id;
  SELECT * INTO active_group
  FROM operations_active_shipment_groups shipment_group
  WHERE shipment_group.organization_id = NEW.organization_id
    AND shipment_group.id = NEW.active_shipment_group_id
    AND shipment_group.active_fulfillment_execution_id
      = NEW.active_fulfillment_execution_id;
  IF active_execution.id IS NULL
     OR active_group.id IS NULL
     OR active_execution.authority_mode IS DISTINCT FROM 'active'
     OR active_execution.state IS DISTINCT FROM 'prepared'
     OR active_execution.activation_revision
       IS DISTINCT FROM NEW.activation_revision
     OR active_execution.order_id IS DISTINCT FROM NEW.order_id
     OR active_execution.plan_id IS DISTINCT FROM NEW.plan_id
     OR active_execution.warehouse_id IS DISTINCT FROM NEW.warehouse_id
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate must bind one exact Active execution and shipment group';
  END IF;

  SELECT * INTO shadow_execution
  FROM operations_fulfillment_executions execution
  WHERE execution.organization_id = NEW.organization_id
    AND execution.id = active_execution.shadow_fulfillment_execution_id;
  SELECT * INTO source_run
  FROM operations_pack_rate_runs run
  WHERE run.organization_id = NEW.organization_id
    AND run.id = NEW.source_fulfillment_pack_rate_run_id;
  IF shadow_execution.id IS NULL
     OR source_run.id IS NULL
     OR shadow_execution.fulfillment_pack_rate_run_id
       IS DISTINCT FROM NEW.source_fulfillment_pack_rate_run_id
     OR source_run.purpose IS DISTINCT FROM 'fulfillment_execution'
     OR source_run.status IS DISTINCT FROM 'succeeded'
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate requires the exact successful Shadow fulfillment pack-rate source';
  END IF;

  SELECT * INTO current_order
  FROM operations_orders orders
  WHERE orders.organization_id = NEW.organization_id
    AND orders.id = NEW.order_id;
  IF current_order.id IS NULL
     OR current_order.currency IS DISTINCT FROM NEW.currency
     OR NOT operations_dispatch_address_matches_core(
       NEW.destination_snapshot,
       current_order.ship_to
     )
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate destination or currency is stale';
  END IF;
  IF active_group.package_count IS DISTINCT FROM NEW.package_count THEN
    RAISE EXCEPTION
      'Production fulfillment rerate package count does not match the Active group';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_production_rerate_run_insert_trigger
BEFORE INSERT ON operations_production_fulfillment_rerate_runs
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_production_rerate_run_insert();

CREATE OR REPLACE FUNCTION
  validate_operations_production_rerate_package_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  active_package operations_active_execution_packages%ROWTYPE;
  physical_package operations_packages%ROWTYPE;
BEGIN
  SELECT * INTO active_package
  FROM operations_active_execution_packages package
  WHERE package.organization_id = NEW.organization_id
    AND package.active_fulfillment_execution_id
      = NEW.active_fulfillment_execution_id
    AND package.active_shipment_group_id = NEW.active_shipment_group_id
    AND package.package_id = NEW.package_id;
  SELECT * INTO physical_package
  FROM operations_packages package
  WHERE package.organization_id = NEW.organization_id
    AND package.id = NEW.package_id;
  IF active_package.package_id IS NULL
     OR physical_package.id IS NULL
     OR active_package.package_key IS DISTINCT FROM NEW.package_key
     OR active_package.package_number IS DISTINCT FROM NEW.package_number
     OR physical_package.global_id IS DISTINCT FROM NEW.package_global_id
     OR physical_package.package_number IS DISTINCT FROM NEW.package_number
     OR physical_package.length_mm IS DISTINCT FROM NEW.length_mm
     OR physical_package.width_mm IS DISTINCT FROM NEW.width_mm
     OR physical_package.height_mm IS DISTINCT FROM NEW.height_mm
     OR physical_package.weight_grams IS DISTINCT FROM NEW.weight_grams
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate package must snapshot one exact Active physical package';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_production_rerate_package_insert_trigger
BEFORE INSERT ON operations_production_fulfillment_rerate_packages
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_production_rerate_package_insert();

CREATE OR REPLACE FUNCTION
  validate_operations_production_rerate_attempt_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rerate_run operations_production_fulfillment_rerate_runs%ROWTYPE;
  integration_account operations_integration_accounts%ROWTYPE;
  carrier_account operations_carrier_accounts%ROWTYPE;
  carrier_credential operations_carrier_credentials%ROWTYPE;
  prior_attempt_id uuid;
  prior_attempt_number integer;
  prior_result_state text;
  expected_billing_snapshot jsonb;
BEGIN
  SELECT * INTO rerate_run
  FROM operations_production_fulfillment_rerate_runs run
  WHERE run.organization_id = NEW.organization_id
    AND run.id = NEW.rerate_run_id;
  IF rerate_run.id IS NULL THEN
    RAISE EXCEPTION 'Production fulfillment rerate run was not found';
  END IF;
  PERFORM 1
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id
    AND activation.state = 'active'
    AND activation.revision = rerate_run.activation_revision
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Production fulfillment rerate attempt requires the current Operations Active revision';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM operations_orders orders
    WHERE orders.organization_id = rerate_run.organization_id
      AND orders.id = rerate_run.order_id
      AND (
        NOT operations_dispatch_address_matches_core(
          rerate_run.destination_snapshot,
          orders.ship_to
        )
        OR orders.currency IS DISTINCT FROM rerate_run.currency
      )
  ) THEN
    RAISE EXCEPTION
      'Production fulfillment rerate destination or currency changed after run preparation';
  END IF;

  SELECT * INTO integration_account
  FROM operations_integration_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id;
  SELECT * INTO carrier_account
  FROM operations_carrier_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.integration_account_id = NEW.integration_account_id
    AND account.id = NEW.carrier_account_id;
  SELECT * INTO carrier_credential
  FROM operations_carrier_credentials credential
  WHERE credential.organization_id = NEW.organization_id
    AND credential.integration_account_id = NEW.integration_account_id;
  IF integration_account.id IS NULL
     OR integration_account.integration_type IS DISTINCT FROM 'carrier'
     OR integration_account.provider IS DISTINCT FROM NEW.provider
     OR integration_account.environment IS DISTINCT FROM 'production'
     OR integration_account.status IS DISTINCT FROM 'active'
     OR carrier_account.id IS NULL
     OR carrier_account.status IS DISTINCT FROM 'active'
     OR carrier_account.configuration_revision
       IS DISTINCT FROM NEW.carrier_account_configuration_revision
     OR carrier_account.account_number_fingerprint
       IS DISTINCT FROM NEW.account_number_fingerprint
     OR carrier_account.registered_address_fingerprint
       IS DISTINCT FROM NEW.registered_origin_fingerprint
     OR NOT operations_dispatch_address_matches_core(
       NEW.origin_snapshot,
       carrier_account.registered_address
     )
     OR carrier_account.sender_name IS DISTINCT FROM NEW.sender_name_snapshot
     OR carrier_credential.integration_account_id IS NULL
     OR carrier_credential.verification_status IS DISTINCT FROM 'verified'
     OR carrier_credential.credential_version
       IS DISTINCT FROM NEW.credential_revision
     OR carrier_credential.credential_fingerprint
       IS DISTINCT FROM NEW.credential_fingerprint
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate attempt requires the exact current production account and credential revision';
  END IF;

  IF (NEW.billing_relationship = 'sender'
      AND carrier_account.allow_sender_billing IS DISTINCT FROM true)
     OR (NEW.billing_relationship = 'recipient'
      AND carrier_account.allow_recipient_billing IS DISTINCT FROM true)
     OR (NEW.billing_relationship = 'third_party'
      AND carrier_account.allow_third_party_billing IS DISTINCT FROM true)
     OR (
       NEW.billing_relationship = 'sender'
       AND NEW.payer_account_number_fingerprint
         IS DISTINCT FROM carrier_account.account_number_fingerprint
     )
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate billing relationship is not authorized by the selected account revision';
  END IF;
  expected_billing_snapshot := jsonb_build_object(
    'relationship', NEW.billing_relationship,
    'payerAccountNumberFingerprint',
      NEW.payer_account_number_fingerprint,
    'payerCountryCode', NEW.payer_country_code,
    'payerPostalCode', NEW.payer_postal_code
  );
  IF NEW.billing_snapshot IS DISTINCT FROM expected_billing_snapshot THEN
    RAISE EXCEPTION
      'Production fulfillment rerate billing snapshot does not match its exact columns';
  END IF;

  SELECT attempt.id, attempt.attempt_number, result.state
    INTO prior_attempt_id, prior_attempt_number, prior_result_state
  FROM operations_production_fulfillment_rerate_attempts attempt
  LEFT JOIN operations_production_fulfillment_rerate_results result
    ON result.organization_id = attempt.organization_id
   AND result.attempt_id = attempt.id
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.rerate_run_id = NEW.rerate_run_id
    AND attempt.provider = NEW.provider
  ORDER BY attempt.attempt_number DESC
  LIMIT 1
  FOR UPDATE OF attempt;
  IF prior_attempt_id IS NOT NULL
     AND prior_result_state IS DISTINCT FROM 'failed'
  THEN
    RAISE EXCEPTION
      'Prepared, succeeded, or unknown production rerate attempt cannot be retried';
  END IF;
  IF NEW.attempt_number IS DISTINCT FROM COALESCE(
    prior_attempt_number + 1,
    1
  ) THEN
    RAISE EXCEPTION
      'Production fulfillment rerate attempt number must be consecutive per provider';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_production_rerate_attempt_insert_trigger
BEFORE INSERT ON operations_production_fulfillment_rerate_attempts
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_production_rerate_attempt_insert();

CREATE OR REPLACE FUNCTION
  validate_operations_production_rerate_result_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prepared_at timestamptz;
BEGIN
  SELECT attempt.persisted_at INTO prepared_at
  FROM operations_production_fulfillment_rerate_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.id = NEW.attempt_id
    AND attempt.rerate_run_id = NEW.rerate_run_id;
  IF prepared_at IS NULL
     OR NEW.completed_at < prepared_at
     OR NEW.completed_at > clock_timestamp()
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate result must follow its durable prepared attempt and cannot be future-dated';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_production_rerate_result_insert_trigger
BEFORE INSERT ON operations_production_fulfillment_rerate_results
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_production_rerate_result_insert();

CREATE OR REPLACE FUNCTION
  validate_operations_production_rerate_offer_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  result_row operations_production_fulfillment_rerate_results%ROWTYPE;
  attempt_provider text;
  run_currency text;
BEGIN
  SELECT * INTO result_row
  FROM operations_production_fulfillment_rerate_results result
  WHERE result.organization_id = NEW.organization_id
    AND result.id = NEW.result_id
    AND result.rerate_run_id = NEW.rerate_run_id
    AND result.attempt_id = NEW.attempt_id;
  SELECT attempt.provider INTO attempt_provider
  FROM operations_production_fulfillment_rerate_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.id = NEW.attempt_id;
  SELECT run.currency INTO run_currency
  FROM operations_production_fulfillment_rerate_runs run
  WHERE run.organization_id = NEW.organization_id
    AND run.id = NEW.rerate_run_id;
  IF result_row.id IS NULL
     OR result_row.state IS DISTINCT FROM 'succeeded'
     OR attempt_provider IS DISTINCT FROM NEW.provider
     OR run_currency IS DISTINCT FROM NEW.currency
     OR result_row.expires_at IS DISTINCT FROM NEW.expires_at
     OR NEW.created_at >= NEW.expires_at
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate offer requires one successful unexpired exact provider result';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_production_rerate_offer_insert_trigger
BEFORE INSERT ON operations_production_fulfillment_rerate_offers
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_production_rerate_offer_insert();

CREATE OR REPLACE FUNCTION
  validate_operations_production_rerate_selection_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rerate_run operations_production_fulfillment_rerate_runs%ROWTYPE;
  attempt_row operations_production_fulfillment_rerate_attempts%ROWTYPE;
  result_row operations_production_fulfillment_rerate_results%ROWTYPE;
  offer_row operations_production_fulfillment_rerate_offers%ROWTYPE;
  integration_account operations_integration_accounts%ROWTYPE;
  carrier_account operations_carrier_accounts%ROWTYPE;
  carrier_credential operations_carrier_credentials%ROWTYPE;
BEGIN
  SELECT * INTO rerate_run
  FROM operations_production_fulfillment_rerate_runs run
  WHERE run.organization_id = NEW.organization_id
    AND run.id = NEW.rerate_run_id;
  SELECT * INTO attempt_row
  FROM operations_production_fulfillment_rerate_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.id = NEW.attempt_id
    AND attempt.rerate_run_id = NEW.rerate_run_id;
  SELECT * INTO result_row
  FROM operations_production_fulfillment_rerate_results result
  WHERE result.organization_id = NEW.organization_id
    AND result.id = NEW.result_id
    AND result.rerate_run_id = NEW.rerate_run_id
    AND result.attempt_id = NEW.attempt_id;
  SELECT * INTO offer_row
  FROM operations_production_fulfillment_rerate_offers offer
  WHERE offer.organization_id = NEW.organization_id
    AND offer.id = NEW.offer_id
    AND offer.rerate_run_id = NEW.rerate_run_id
    AND offer.attempt_id = NEW.attempt_id
    AND offer.result_id = NEW.result_id;
  IF rerate_run.id IS NULL
     OR attempt_row.id IS NULL
     OR result_row.id IS NULL
     OR offer_row.id IS NULL
     OR result_row.state IS DISTINCT FROM 'succeeded'
     OR NEW.active_fulfillment_execution_id
       IS DISTINCT FROM rerate_run.active_fulfillment_execution_id
     OR NEW.active_shipment_group_id
       IS DISTINCT FROM rerate_run.active_shipment_group_id
     OR NEW.provider IS DISTINCT FROM attempt_row.provider
     OR NEW.provider IS DISTINCT FROM offer_row.provider
     OR NEW.service_code IS DISTINCT FROM offer_row.service_code
     OR NEW.service_name IS DISTINCT FROM offer_row.service_name
     OR NEW.amount_minor IS DISTINCT FROM offer_row.amount_minor
     OR NEW.currency IS DISTINCT FROM offer_row.currency
     OR NEW.integration_account_id
       IS DISTINCT FROM attempt_row.integration_account_id
     OR NEW.carrier_account_id
       IS DISTINCT FROM attempt_row.carrier_account_id
     OR NEW.carrier_account_configuration_revision
       IS DISTINCT FROM attempt_row.carrier_account_configuration_revision
     OR NEW.account_number_fingerprint
       IS DISTINCT FROM attempt_row.account_number_fingerprint
     OR NEW.registered_origin_fingerprint
       IS DISTINCT FROM attempt_row.registered_origin_fingerprint
     OR NEW.credential_revision
       IS DISTINCT FROM attempt_row.credential_revision
     OR NEW.credential_fingerprint
       IS DISTINCT FROM attempt_row.credential_fingerprint
     OR NEW.adapter_version IS DISTINCT FROM attempt_row.adapter_version
     OR NEW.provider_reference IS DISTINCT FROM result_row.provider_reference
     OR NEW.input_hash IS DISTINCT FROM rerate_run.input_hash
     OR NEW.result_hash IS DISTINCT FROM result_row.result_hash
     OR NEW.origin_fingerprint IS DISTINCT FROM attempt_row.origin_fingerprint
     OR NEW.destination_fingerprint
       IS DISTINCT FROM rerate_run.destination_fingerprint
     OR NEW.billing_fingerprint
       IS DISTINCT FROM attempt_row.billing_fingerprint
     OR NEW.ordered_package_set_fingerprint
       IS DISTINCT FROM rerate_run.ordered_package_set_fingerprint
     OR NEW.expires_at IS DISTINCT FROM result_row.expires_at
     OR NEW.expires_at IS DISTINCT FROM offer_row.expires_at
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate selection must snapshot one exact successful offer and dispatch binding';
  END IF;
  IF NEW.selected_at < result_row.completed_at
     OR NEW.selected_at >= NEW.expires_at
     OR NEW.selected_at > clock_timestamp()
     OR clock_timestamp() >= NEW.expires_at
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate selection requires a currently unexpired successful offer and cannot be future-dated';
  END IF;

  PERFORM 1
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id
    AND activation.state = 'active'
    AND activation.revision = rerate_run.activation_revision
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Production fulfillment rerate selection requires the current Operations Active revision';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM operations_orders orders
    WHERE orders.organization_id = rerate_run.organization_id
      AND orders.id = rerate_run.order_id
      AND (
        NOT operations_dispatch_address_matches_core(
          rerate_run.destination_snapshot,
          orders.ship_to
        )
        OR orders.currency IS DISTINCT FROM rerate_run.currency
      )
  ) THEN
    RAISE EXCEPTION
      'Production fulfillment rerate selection destination or currency is stale';
  END IF;

  SELECT * INTO integration_account
  FROM operations_integration_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id;
  SELECT * INTO carrier_account
  FROM operations_carrier_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.integration_account_id = NEW.integration_account_id
    AND account.id = NEW.carrier_account_id;
  SELECT * INTO carrier_credential
  FROM operations_carrier_credentials credential
  WHERE credential.organization_id = NEW.organization_id
    AND credential.integration_account_id = NEW.integration_account_id;
  IF integration_account.id IS NULL
     OR integration_account.integration_type IS DISTINCT FROM 'carrier'
     OR integration_account.provider IS DISTINCT FROM NEW.provider
     OR integration_account.provider IS DISTINCT FROM attempt_row.provider
     OR integration_account.environment IS DISTINCT FROM 'production'
     OR integration_account.status IS DISTINCT FROM 'active'
     OR carrier_account.id IS NULL
     OR carrier_account.status IS DISTINCT FROM 'active'
     OR carrier_account.configuration_revision
       IS DISTINCT FROM NEW.carrier_account_configuration_revision
     OR carrier_account.account_number_fingerprint
       IS DISTINCT FROM NEW.account_number_fingerprint
     OR carrier_account.registered_address_fingerprint
       IS DISTINCT FROM NEW.registered_origin_fingerprint
     OR carrier_credential.integration_account_id IS NULL
     OR carrier_credential.verification_status IS DISTINCT FROM 'verified'
     OR carrier_credential.credential_version
       IS DISTINCT FROM NEW.credential_revision
     OR carrier_credential.credential_fingerprint
       IS DISTINCT FROM NEW.credential_fingerprint
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate selection integration, account, or credential revision is stale';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_production_rerate_selection_insert_trigger
BEFORE INSERT ON operations_production_fulfillment_rerate_selections
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_production_rerate_selection_insert();

CREATE OR REPLACE FUNCTION
  validate_operations_production_rerate_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_run_id uuid;
  target_organization_id uuid;
  rerate_run operations_production_fulfillment_rerate_runs%ROWTYPE;
  package_rows bigint;
  active_package_rows bigint;
  package_mismatch_rows bigint;
BEGIN
  target_organization_id := NEW.organization_id;
  IF TG_TABLE_NAME = 'operations_production_fulfillment_rerate_runs' THEN
    target_run_id := NEW.id;
  ELSE
    target_run_id := NEW.rerate_run_id;
  END IF;
  SELECT * INTO rerate_run
  FROM operations_production_fulfillment_rerate_runs run
  WHERE run.organization_id = target_organization_id
    AND run.id = target_run_id;
  IF rerate_run.id IS NULL THEN
    RAISE EXCEPTION 'Production fulfillment rerate run was not found';
  END IF;

  SELECT count(*) INTO package_rows
  FROM operations_production_fulfillment_rerate_packages package
  WHERE package.organization_id = target_organization_id
    AND package.rerate_run_id = target_run_id;
  SELECT count(*) INTO active_package_rows
  FROM operations_active_execution_packages package
  WHERE package.organization_id = target_organization_id
    AND package.active_fulfillment_execution_id
      = rerate_run.active_fulfillment_execution_id
    AND package.active_shipment_group_id
      = rerate_run.active_shipment_group_id;
  SELECT count(*) INTO package_mismatch_rows
  FROM (
    (
      SELECT package_id, package_key, package_number
      FROM operations_production_fulfillment_rerate_packages
      WHERE organization_id = rerate_run.organization_id
        AND rerate_run_id = rerate_run.id
      EXCEPT
      SELECT package_id, package_key, package_number
      FROM operations_active_execution_packages
      WHERE organization_id = rerate_run.organization_id
        AND active_fulfillment_execution_id
          = rerate_run.active_fulfillment_execution_id
        AND active_shipment_group_id
          = rerate_run.active_shipment_group_id
    )
    UNION ALL
    (
      SELECT package_id, package_key, package_number
      FROM operations_active_execution_packages
      WHERE organization_id = rerate_run.organization_id
        AND active_fulfillment_execution_id
          = rerate_run.active_fulfillment_execution_id
        AND active_shipment_group_id
          = rerate_run.active_shipment_group_id
      EXCEPT
      SELECT package_id, package_key, package_number
      FROM operations_production_fulfillment_rerate_packages
      WHERE organization_id = rerate_run.organization_id
        AND rerate_run_id = rerate_run.id
    )
  ) mismatch;
  IF package_rows IS DISTINCT FROM rerate_run.package_count::bigint
     OR active_package_rows IS DISTINCT FROM package_rows
     OR package_mismatch_rows <> 0
     OR EXISTS (
       SELECT 1
       FROM operations_production_fulfillment_rerate_packages package
       WHERE package.organization_id = target_organization_id
         AND package.rerate_run_id = target_run_id
       HAVING min(package.package_number) <> 1
          OR max(package.package_number) <> count(*)
     )
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate requires the complete ordered Active package set';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM operations_production_fulfillment_rerate_results result
    LEFT JOIN operations_production_fulfillment_rerate_offers offer
      ON offer.organization_id = result.organization_id
     AND offer.result_id = result.id
    WHERE result.organization_id = target_organization_id
      AND result.rerate_run_id = target_run_id
    GROUP BY result.id, result.state
    HAVING (
      result.state = 'succeeded' AND count(offer.id) < 1
    ) OR (
      result.state IN ('failed', 'unknown') AND count(offer.id) <> 0
    )
  ) THEN
    RAISE EXCEPTION
      'Production fulfillment rerate result and normalized offers are incomplete';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER validate_operations_production_rerate_run_deferred
AFTER INSERT ON operations_production_fulfillment_rerate_runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_production_rerate_complete();

CREATE CONSTRAINT TRIGGER
  validate_operations_production_rerate_package_deferred
AFTER INSERT ON operations_production_fulfillment_rerate_packages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_production_rerate_complete();

CREATE CONSTRAINT TRIGGER
  validate_operations_production_rerate_attempt_deferred
AFTER INSERT ON operations_production_fulfillment_rerate_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_production_rerate_complete();

CREATE CONSTRAINT TRIGGER
  validate_operations_production_rerate_result_deferred
AFTER INSERT ON operations_production_fulfillment_rerate_results
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_production_rerate_complete();

CREATE CONSTRAINT TRIGGER
  validate_operations_production_rerate_offer_deferred
AFTER INSERT ON operations_production_fulfillment_rerate_offers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_production_rerate_complete();

CREATE CONSTRAINT TRIGGER
  validate_operations_production_rerate_selection_deferred
AFTER INSERT ON operations_production_fulfillment_rerate_selections
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_production_rerate_complete();

-- Dispatch is downstream of selection. No existing carrier dispatch attempt
-- may be guessed or backfilled; the migration preflight above enforces that
-- release boundary before this NOT NULL column is installed.
ALTER TABLE operations_active_carrier_group_attempts
  ADD COLUMN IF NOT EXISTS production_rerate_selection_id uuid;

ALTER TABLE operations_active_carrier_group_attempts
  ALTER COLUMN production_rerate_selection_id SET NOT NULL,
  ADD CONSTRAINT operations_active_carrier_attempts_selection_fkey
    FOREIGN KEY (
      organization_id, production_rerate_selection_id,
      active_fulfillment_execution_id, active_shipment_group_id
    )
    REFERENCES operations_production_fulfillment_rerate_selections(
      organization_id, id,
      active_fulfillment_execution_id, active_shipment_group_id
    ) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION
  protect_operations_active_carrier_group_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Active carrier group attempts are immutable and cannot be deleted';
  END IF;
  IF ROW(
    NEW.global_id,
    NEW.organization_id,
    NEW.active_fulfillment_execution_id,
    NEW.active_shipment_group_id,
    NEW.production_rerate_selection_id,
    NEW.attempt_number,
    NEW.environment,
    NEW.selected_provider,
    NEW.selected_service_code,
    NEW.selected_service_name,
    NEW.package_count,
    NEW.adapter_version,
    NEW.idempotency_key,
    NEW.request_hash,
    NEW.redacted_request,
    NEW.actor_email,
    NEW.persisted_at,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id,
    OLD.organization_id,
    OLD.active_fulfillment_execution_id,
    OLD.active_shipment_group_id,
    OLD.production_rerate_selection_id,
    OLD.attempt_number,
    OLD.environment,
    OLD.selected_provider,
    OLD.selected_service_code,
    OLD.selected_service_name,
    OLD.package_count,
    OLD.adapter_version,
    OLD.idempotency_key,
    OLD.request_hash,
    OLD.redacted_request,
    OLD.actor_email,
    OLD.persisted_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'Active carrier group attempt identity and request are immutable';
  END IF;
  IF OLD.state <> 'prepared' THEN
    RAISE EXCEPTION
      'Terminal Active carrier group attempt cannot be retried or changed';
  END IF;
  IF NEW.state = 'prepared' OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION
      'Active carrier group attempt must finalize exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  validate_operations_active_carrier_group_attempt_prepare()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  activation_state text;
  current_activation_revision integer;
  shipment_group operations_active_shipment_groups%ROWTYPE;
  selection operations_production_fulfillment_rerate_selections%ROWTYPE;
  rerate_run operations_production_fulfillment_rerate_runs%ROWTYPE;
  rerate_attempt
    operations_production_fulfillment_rerate_attempts%ROWTYPE;
  integration_account operations_integration_accounts%ROWTYPE;
  carrier_account operations_carrier_accounts%ROWTYPE;
  carrier_credential operations_carrier_credentials%ROWTYPE;
  current_order operations_orders%ROWTYPE;
  prior_attempt_state text;
  expected_attempt_number integer;
BEGIN
  SELECT activation.state, activation.revision
    INTO activation_state, current_activation_revision
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id;
  IF activation_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'Active carrier group attempt requires Operations Active';
  END IF;

  SELECT * INTO shipment_group
  FROM operations_active_shipment_groups candidate
  WHERE candidate.organization_id = NEW.organization_id
    AND candidate.id = NEW.active_shipment_group_id
    AND candidate.active_fulfillment_execution_id
      = NEW.active_fulfillment_execution_id;
  SELECT * INTO selection
  FROM operations_production_fulfillment_rerate_selections candidate
  WHERE candidate.organization_id = NEW.organization_id
    AND candidate.id = NEW.production_rerate_selection_id
    AND candidate.active_fulfillment_execution_id
      = NEW.active_fulfillment_execution_id
    AND candidate.active_shipment_group_id = NEW.active_shipment_group_id;
  SELECT * INTO rerate_run
  FROM operations_production_fulfillment_rerate_runs run
  WHERE run.organization_id = NEW.organization_id
    AND run.id = selection.rerate_run_id;
  SELECT * INTO rerate_attempt
  FROM operations_production_fulfillment_rerate_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.id = selection.attempt_id
    AND attempt.rerate_run_id = selection.rerate_run_id;
  SELECT * INTO integration_account
  FROM operations_integration_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.id = selection.integration_account_id;
  SELECT * INTO carrier_account
  FROM operations_carrier_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.integration_account_id = selection.integration_account_id
    AND account.id = selection.carrier_account_id;
  SELECT * INTO carrier_credential
  FROM operations_carrier_credentials credential
  WHERE credential.organization_id = NEW.organization_id
    AND credential.integration_account_id = selection.integration_account_id;
  SELECT * INTO current_order
  FROM operations_orders orders
  WHERE orders.organization_id = NEW.organization_id
    AND orders.id = rerate_run.order_id;
  IF shipment_group.id IS NULL
     OR selection.id IS NULL
     OR rerate_run.id IS NULL
     OR rerate_attempt.id IS NULL
     OR current_activation_revision
       IS DISTINCT FROM rerate_run.activation_revision
     OR NEW.persisted_at >= selection.expires_at
     OR clock_timestamp() >= selection.expires_at
     OR NEW.selected_provider IS DISTINCT FROM selection.provider
     OR NEW.selected_service_code IS DISTINCT FROM selection.service_code
     OR NEW.selected_service_name IS DISTINCT FROM selection.service_name
     OR NEW.package_count IS DISTINCT FROM rerate_run.package_count
  THEN
    RAISE EXCEPTION
      'Active carrier attempt requires the exact current unexpired production rerate selection';
  END IF;

  IF current_order.id IS NULL
     OR current_order.currency IS DISTINCT FROM rerate_run.currency
     OR NOT operations_dispatch_address_matches_core(
       rerate_run.destination_snapshot,
       current_order.ship_to
     )
  THEN
    RAISE EXCEPTION
      'Active carrier attempt destination or currency changed after production rerating';
  END IF;

  IF integration_account.id IS NULL
     OR integration_account.integration_type IS DISTINCT FROM 'carrier'
     OR integration_account.provider IS DISTINCT FROM selection.provider
     OR integration_account.environment IS DISTINCT FROM 'production'
     OR integration_account.status IS DISTINCT FROM 'active'
     OR carrier_account.id IS NULL
     OR carrier_account.status IS DISTINCT FROM 'active'
     OR carrier_account.configuration_revision
       IS DISTINCT FROM selection.carrier_account_configuration_revision
     OR carrier_account.configuration_revision
       IS DISTINCT FROM rerate_attempt.carrier_account_configuration_revision
     OR carrier_account.account_number_fingerprint
       IS DISTINCT FROM selection.account_number_fingerprint
     OR carrier_account.account_number_fingerprint
       IS DISTINCT FROM rerate_attempt.account_number_fingerprint
     OR carrier_account.registered_address_fingerprint
       IS DISTINCT FROM selection.registered_origin_fingerprint
     OR carrier_account.registered_address_fingerprint
       IS DISTINCT FROM rerate_attempt.registered_origin_fingerprint
     OR NOT operations_dispatch_address_matches_core(
       rerate_attempt.origin_snapshot,
       carrier_account.registered_address
     )
     OR rerate_attempt.origin_fingerprint
       IS DISTINCT FROM selection.origin_fingerprint
     OR rerate_attempt.billing_fingerprint
       IS DISTINCT FROM selection.billing_fingerprint
     OR (
       rerate_attempt.billing_relationship = 'sender'
       AND carrier_account.allow_sender_billing IS DISTINCT FROM true
     )
     OR (
       rerate_attempt.billing_relationship = 'recipient'
       AND carrier_account.allow_recipient_billing IS DISTINCT FROM true
     )
     OR (
       rerate_attempt.billing_relationship = 'third_party'
       AND carrier_account.allow_third_party_billing IS DISTINCT FROM true
     )
     OR carrier_credential.integration_account_id IS NULL
     OR carrier_credential.verification_status IS DISTINCT FROM 'verified'
     OR carrier_credential.credential_version
       IS DISTINCT FROM selection.credential_revision
     OR carrier_credential.credential_version
       IS DISTINCT FROM rerate_attempt.credential_revision
     OR carrier_credential.credential_fingerprint
       IS DISTINCT FROM selection.credential_fingerprint
     OR carrier_credential.credential_fingerprint
       IS DISTINCT FROM rerate_attempt.credential_fingerprint
  THEN
    RAISE EXCEPTION
      'Active carrier attempt requires the current production integration, account, credential, origin, and billing authority';
  END IF;

  SELECT attempt.state, attempt.attempt_number + 1
    INTO prior_attempt_state, expected_attempt_number
  FROM operations_active_carrier_group_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.active_shipment_group_id = NEW.active_shipment_group_id
  ORDER BY attempt.attempt_number DESC
  LIMIT 1;
  expected_attempt_number := COALESCE(expected_attempt_number, 1);
  IF prior_attempt_state IS NOT NULL AND prior_attempt_state <> 'failed' THEN
    RAISE EXCEPTION
      'Prepared, succeeded, or unknown Active carrier attempt cannot be retried';
  END IF;
  IF NEW.attempt_number <> expected_attempt_number THEN
    RAISE EXCEPTION
      'Active carrier group attempt number must be consecutive';
  END IF;
  RETURN NEW;
END;
$$;

-- Replace the 0179 deferred validator. Active execution/package preparation
-- is now legal before any carrier dispatch exists. The Active shipment-group
-- service/cost remains an inherited Shadow planning estimate; the immutable
-- production rerate selection is the dispatch authority and may differ.
CREATE OR REPLACE FUNCTION
  validate_operations_active_execution_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  execution operations_active_fulfillment_executions%ROWTYPE;
  shipment_group operations_active_shipment_groups%ROWTYPE;
  shadow_group operations_shipment_groups%ROWTYPE;
  carrier_attempt operations_active_carrier_group_attempts%ROWTYPE;
  production_selection
    operations_production_fulfillment_rerate_selections%ROWTYPE;
  production_run
    operations_production_fulfillment_rerate_runs%ROWTYPE;
  package_rows bigint;
  shadow_package_rows bigint;
  package_mismatch_rows bigint;
  result_rows bigint;
  result_mismatch_rows bigint;
  label_rows bigint;
  shipment_rows bigint;
BEGIN
  IF TG_TABLE_NAME = 'operations_active_fulfillment_executions' THEN
    execution := NEW;
  ELSIF TG_TABLE_NAME = 'operations_active_shipment_groups' THEN
    SELECT * INTO execution
    FROM operations_active_fulfillment_executions candidate
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.id = NEW.active_fulfillment_execution_id;
  ELSIF TG_TABLE_NAME IN (
    'operations_active_carrier_group_attempts',
    'operations_active_carrier_package_results',
    'operations_label_attempts',
    'operations_labels',
    'operations_shipments'
  ) THEN
    IF NEW.active_fulfillment_execution_id IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT * INTO execution
    FROM operations_active_fulfillment_executions candidate
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.id = NEW.active_fulfillment_execution_id;
  ELSE
    SELECT * INTO execution
    FROM operations_active_fulfillment_executions candidate
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.id = NEW.active_fulfillment_execution_id;
  END IF;
  IF execution.id IS NULL THEN
    RAISE EXCEPTION 'Active fulfillment execution was not found';
  END IF;

  SELECT * INTO shipment_group
  FROM operations_active_shipment_groups candidate
  WHERE candidate.organization_id = execution.organization_id
    AND candidate.active_fulfillment_execution_id = execution.id;
  SELECT * INTO shadow_group
  FROM operations_shipment_groups candidate
  WHERE candidate.organization_id = execution.organization_id
    AND candidate.fulfillment_execution_id
      = execution.shadow_fulfillment_execution_id;
  SELECT * INTO carrier_attempt
  FROM operations_active_carrier_group_attempts candidate
  WHERE candidate.organization_id = execution.organization_id
    AND candidate.active_fulfillment_execution_id = execution.id
  ORDER BY candidate.attempt_number DESC
  LIMIT 1;

  SELECT count(*) INTO package_rows
  FROM operations_active_execution_packages package
  WHERE package.organization_id = execution.organization_id
    AND package.active_fulfillment_execution_id = execution.id;
  SELECT count(*) INTO shadow_package_rows
  FROM operations_fulfillment_execution_packages package
  WHERE package.organization_id = execution.organization_id
    AND package.execution_id = execution.shadow_fulfillment_execution_id;
  SELECT count(*) INTO package_mismatch_rows
  FROM (
    (
      SELECT package_id, package_key
      FROM operations_active_execution_packages
      WHERE organization_id = execution.organization_id
        AND active_fulfillment_execution_id = execution.id
      EXCEPT
      SELECT package_id, package_key
      FROM operations_fulfillment_execution_packages
      WHERE organization_id = execution.organization_id
        AND execution_id = execution.shadow_fulfillment_execution_id
    )
    UNION ALL
    (
      SELECT package_id, package_key
      FROM operations_fulfillment_execution_packages
      WHERE organization_id = execution.organization_id
        AND execution_id = execution.shadow_fulfillment_execution_id
      EXCEPT
      SELECT package_id, package_key
      FROM operations_active_execution_packages
      WHERE organization_id = execution.organization_id
        AND active_fulfillment_execution_id = execution.id
    )
  ) mismatch;

  IF shipment_group.id IS NULL
     OR shadow_group.id IS NULL
     OR shipment_group.shadow_shipment_group_id
       IS DISTINCT FROM shadow_group.id
     OR shipment_group.selected_provider
       IS DISTINCT FROM shadow_group.selected_provider
     OR shipment_group.selected_service_code
       IS DISTINCT FROM shadow_group.selected_service_code
     OR shipment_group.selected_service_name
       IS DISTINCT FROM shadow_group.selected_service_name
     OR shipment_group.selected_carrier_cost_minor
       IS DISTINCT FROM shadow_group.selected_carrier_cost_minor
     OR shipment_group.currency IS DISTINCT FROM shadow_group.currency
     OR shipment_group.package_count <> package_rows
     OR package_rows <> shadow_package_rows
     OR package_mismatch_rows <> 0
  THEN
    RAISE EXCEPTION
      'Active execution requires one exact Shadow-derived planning estimate and package group';
  END IF;

  SELECT count(*) INTO label_rows
  FROM operations_labels label
  WHERE label.organization_id = execution.organization_id
    AND label.active_fulfillment_execution_id = execution.id
    AND label.status = 'created';
  SELECT count(*) INTO shipment_rows
  FROM operations_shipments shipment
  WHERE shipment.organization_id = execution.organization_id
    AND shipment.active_fulfillment_execution_id = execution.id
    AND shipment.status <> 'voided';

  IF carrier_attempt.id IS NULL THEN
    IF label_rows <> 0 OR shipment_rows <> 0 THEN
      RAISE EXCEPTION
        'Prepared Active execution without a carrier attempt cannot retain provider results';
    END IF;
    RETURN NULL;
  END IF;

  SELECT * INTO production_selection
  FROM operations_production_fulfillment_rerate_selections selection
  WHERE selection.organization_id = carrier_attempt.organization_id
    AND selection.id = carrier_attempt.production_rerate_selection_id;
  SELECT * INTO production_run
  FROM operations_production_fulfillment_rerate_runs run
  WHERE run.organization_id = production_selection.organization_id
    AND run.id = production_selection.rerate_run_id;
  IF production_selection.id IS NULL
     OR production_run.id IS NULL
     OR production_selection.active_fulfillment_execution_id
       IS DISTINCT FROM execution.id
     OR production_selection.active_shipment_group_id
       IS DISTINCT FROM shipment_group.id
     OR production_run.activation_revision
       IS DISTINCT FROM execution.activation_revision
     OR production_run.package_count IS DISTINCT FROM package_rows::integer
     OR carrier_attempt.active_shipment_group_id
       IS DISTINCT FROM shipment_group.id
     OR carrier_attempt.selected_provider
       IS DISTINCT FROM production_selection.provider
     OR carrier_attempt.selected_service_code
       IS DISTINCT FROM production_selection.service_code
     OR carrier_attempt.selected_service_name
       IS DISTINCT FROM production_selection.service_name
     OR carrier_attempt.package_count <> production_run.package_count
  THEN
    RAISE EXCEPTION
      'Active carrier attempt must bind the exact production rerate selection and package set';
  END IF;

  SELECT count(*) INTO result_rows
  FROM operations_active_carrier_package_results result
  WHERE result.organization_id = execution.organization_id
    AND result.carrier_group_attempt_id = carrier_attempt.id;
  SELECT count(*) INTO result_mismatch_rows
  FROM operations_active_carrier_package_results result
  JOIN operations_labels label
    ON label.organization_id = result.organization_id
   AND label.id = result.label_id
  JOIN operations_shipments shipment
    ON shipment.organization_id = result.organization_id
   AND shipment.id = result.shipment_id
  WHERE result.organization_id = execution.organization_id
    AND result.carrier_group_attempt_id = carrier_attempt.id
    AND (
      result.state <> 'succeeded'
      OR label.package_id <> result.package_id
      OR shipment.package_id <> result.package_id
      OR shipment.label_id <> result.label_id
      OR label.tracking_number <> result.tracking_number
      OR shipment.tracking_number <> result.tracking_number
      OR label.service_code <> carrier_attempt.selected_service_code
      OR label.active_carrier_group_attempt_id <> carrier_attempt.id
      OR shipment.active_carrier_group_attempt_id <> carrier_attempt.id
    );

  IF carrier_attempt.state = 'prepared' AND (
    result_rows <> 0 OR label_rows <> 0 OR shipment_rows <> 0
  ) THEN
    RAISE EXCEPTION
      'Prepared Active attempt cannot retain provider results';
  END IF;
  IF carrier_attempt.state = 'failed' AND (
    result_rows <> 0 OR label_rows <> 0 OR shipment_rows <> 0
  ) THEN
    RAISE EXCEPTION
      'Failed Active attempt cannot retain label or shipment results';
  END IF;
  IF carrier_attempt.state = 'succeeded' AND (
    result_rows <> shipment_group.package_count
    OR label_rows <> shipment_group.package_count
    OR shipment_rows <> shipment_group.package_count
    OR result_mismatch_rows <> 0
  ) THEN
    RAISE EXCEPTION
      'Succeeded Active attempt requires one matching label and shipment for every package';
  END IF;
  IF carrier_attempt.state = 'unknown' AND (
    result_rows <> 0 OR label_rows <> 0 OR shipment_rows <> 0
  ) THEN
    RAISE EXCEPTION
      'Unknown Active attempt requires reconciliation and cannot retain assumed package results';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON COLUMN
  operations_active_shipment_groups.selected_service_code IS
  'Inherited immutable Shadow planning estimate. Production dispatch authority is operations_production_fulfillment_rerate_selections.';
COMMENT ON COLUMN
  operations_active_shipment_groups.selected_carrier_cost_minor IS
  'Inherited immutable Shadow planning estimate; it is not the production execution rerate amount.';
COMMENT ON TABLE operations_production_fulfillment_rerate_runs IS
  'Append-only production execution-time rerate bound to one exact current Active order, plan, warehouse, destination, and ordered package set.';
COMMENT ON TABLE operations_production_fulfillment_rerate_attempts IS
  'Immutable provider request persisted before network I/O with exact account, credential, origin, billing, and package-run bindings.';
COMMENT ON TABLE operations_production_fulfillment_rerate_results IS
  'Append-only terminal succeeded, failed, or unknown result for one prepared production provider attempt.';
COMMENT ON TABLE operations_production_fulfillment_rerate_offers IS
  'Immutable normalized whole-shipment carrier service offers from one succeeded production rerate result.';
COMMENT ON TABLE operations_production_fulfillment_rerate_selections IS
  'Exactly one immutable, unexpired production service selection per rerate run; this row is authoritative for Active dispatch.';
COMMENT ON COLUMN
  operations_active_carrier_group_attempts.production_rerate_selection_id IS
  'Required immutable production rerate selection used to authorize this whole-shipment carrier dispatch attempt.';
