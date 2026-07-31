-- Tenant-owned Shopify customer checkout-rate policy intent.
--
-- Customer policies are stored one row per exact Shopify Customer GID. There
-- is deliberately no organization- or account-level customer-count ceiling;
-- every read surface must paginate instead of placing a cohort in one JSON
-- document. This migration authorizes no provider mutation. Shadow rows are
-- local simulations only and expire closed after a configurable 15 through
-- 240 minute proof window (60 minutes by default). Active rows remain
-- explicitly write-blocked until a separately authorized customer-metafield
-- writer is implemented.

INSERT INTO global_reference_entity_types (
  prefix, entity_type, display_name
)
VALUES (
  'gscp',
  'operations.shopify_customer_rate_policy',
  'Shopify customer rate policy'
)
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE OR REPLACE FUNCTION
  operations_shopify_customer_rate_policy_is_valid(
    input_mode text,
    input_service_codes jsonb
  )
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  service_code_count integer;
BEGIN
  IF input_mode NOT IN (
    'show_all', 'hide_all', 'include_only', 'exclude'
  ) OR jsonb_typeof(input_service_codes) IS DISTINCT FROM 'array'
  THEN
    RETURN false;
  END IF;

  service_code_count := jsonb_array_length(input_service_codes);
  IF service_code_count > 50 THEN
    RETURN false;
  END IF;
  IF (
    input_mode IN ('show_all', 'hide_all')
    AND service_code_count <> 0
  ) OR (
    input_mode IN ('include_only', 'exclude')
    AND service_code_count NOT BETWEEN 1 AND 50
  ) THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(input_service_codes) AS item(value)
    WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'string'
       OR (item.value #>> '{}') !~
         '^clawpilot:[a-z0-9]([a-z0-9_-]{0,31}):[a-z0-9]([a-z0-9_-]{0,31})$'
  ) THEN
    RETURN false;
  END IF;
  IF (
    SELECT count(*)
    FROM jsonb_array_elements_text(input_service_codes) AS item(value)
  ) IS DISTINCT FROM (
    SELECT count(DISTINCT item.value)
    FROM jsonb_array_elements_text(input_service_codes) AS item(value)
  ) THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION
  WHEN OTHERS THEN
    RETURN false;
END;
$$;

CREATE TABLE IF NOT EXISTS operations_shopify_customer_rate_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gscp'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  shopify_customer_gid text NOT NULL,
  mode text NOT NULL,
  service_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy_hash text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('simulated', 'blocked', 'enforced', 'error', 'removed')
  ),
  provider_state text NOT NULL CHECK (
    provider_state IN (
      'not_written', 'write_blocked', 'pending', 'applied', 'unknown'
    )
  ),
  provider_metafield_gid text,
  provider_metafield_updated_at timestamptz,
  last_error_code text,
  shadow_duration_minutes smallint,
  shadow_expires_at timestamptz,
  removed_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shopify_customer_rate_policy_global_valid CHECK (
    global_id ~ '^gscp[0-9]{7}$'
  ),
  CONSTRAINT operations_shopify_customer_rate_policy_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_shopify_customer_rate_policy_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_customer_rate_policy_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_customer_rate_policy_customer_gid_valid
    CHECK (
      shopify_customer_gid ~
        '^gid://shopify/Customer/[1-9][0-9]{0,19}$'
    ),
  CONSTRAINT operations_shopify_customer_rate_policy_payload_valid CHECK (
    operations_shopify_customer_rate_policy_is_valid(
      mode,
      service_codes
    )
  ),
  CONSTRAINT operations_shopify_customer_rate_policy_hash_valid CHECK (
    policy_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT operations_shopify_customer_rate_policy_provider_gid_valid
    CHECK (
      provider_metafield_gid IS NULL
      OR provider_metafield_gid ~
        '^gid://shopify/Metafield/[1-9][0-9]{0,19}$'
    ),
  CONSTRAINT operations_shopify_customer_rate_policy_error_code_valid
    CHECK (
      last_error_code IS NULL
      OR (
        length(last_error_code) BETWEEN 3 AND 128
        AND last_error_code ~ '^[A-Z0-9_]+$'
      )
    ),
  CONSTRAINT operations_shopify_customer_rate_policy_shadow_window_valid
    CHECK (
      (
        status = 'simulated'
        AND shadow_duration_minutes IS NOT NULL
        AND shadow_expires_at IS NOT NULL
        AND shadow_duration_minutes BETWEEN 15 AND 240
        AND shadow_expires_at = updated_at
          + (shadow_duration_minutes * interval '1 minute')
      )
      OR (
        status IN ('blocked', 'enforced', 'error')
        AND shadow_duration_minutes IS NULL
        AND shadow_expires_at IS NULL
      )
      OR (
        status = 'removed'
        AND (
          (
            shadow_duration_minutes IS NULL
            AND shadow_expires_at IS NULL
          )
          OR (
            shadow_duration_minutes IS NOT NULL
            AND shadow_duration_minutes BETWEEN 15 AND 240
            AND shadow_expires_at IS NOT NULL
          )
        )
      )
    ),
  CONSTRAINT operations_shopify_customer_rate_policy_state_valid CHECK (
    (
      status = 'simulated'
      AND provider_state = 'not_written'
      AND provider_metafield_gid IS NULL
      AND provider_metafield_updated_at IS NULL
      AND last_error_code IS NULL
      AND removed_at IS NULL
    )
    OR (
      status = 'blocked'
      AND provider_state = 'write_blocked'
      AND provider_metafield_gid IS NULL
      AND provider_metafield_updated_at IS NULL
      AND last_error_code IS NOT NULL
      AND removed_at IS NULL
    )
    OR (
      status = 'enforced'
      AND provider_state = 'applied'
      AND provider_metafield_gid IS NOT NULL
      AND provider_metafield_updated_at IS NOT NULL
      AND last_error_code IS NULL
      AND removed_at IS NULL
    )
    OR (
      status = 'error'
      AND provider_state = 'unknown'
      AND last_error_code IS NOT NULL
      AND removed_at IS NULL
    )
    OR (
      status = 'removed'
      AND provider_state IN ('not_written', 'write_blocked')
      AND provider_metafield_gid IS NULL
      AND provider_metafield_updated_at IS NULL
      AND removed_at IS NOT NULL
      AND (
        (provider_state = 'not_written' AND last_error_code IS NULL)
        OR (
          provider_state = 'write_blocked'
          AND last_error_code IS NOT NULL
        )
      )
    )
  ),
  CONSTRAINT operations_shopify_customer_rate_policy_customer_unique
    UNIQUE (
      organization_id, integration_account_id, shopify_customer_gid
    ),
  CONSTRAINT operations_shopify_customer_rate_policy_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS
  operations_shopify_customer_rate_policy_list_idx
ON operations_shopify_customer_rate_policies (
  organization_id,
  integration_account_id,
  updated_at DESC,
  global_id
);

CREATE INDEX IF NOT EXISTS
  operations_shopify_customer_rate_policy_status_idx
ON operations_shopify_customer_rate_policies (
  organization_id,
  integration_account_id,
  status,
  provider_state
);

CREATE INDEX IF NOT EXISTS
  operations_shopify_customer_rate_policy_shadow_expiry_idx
ON operations_shopify_customer_rate_policies (
  organization_id,
  integration_account_id,
  shadow_expires_at
)
WHERE status = 'simulated'
  AND provider_state = 'not_written';

CREATE OR REPLACE FUNCTION
  validate_operations_shopify_customer_rate_policy_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  integration_provider text;
  integration_type text;
  activation_state text;
BEGIN
  SELECT account.provider, account.integration_type
    INTO integration_provider, integration_type
  FROM operations_integration_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id;

  IF integration_provider IS DISTINCT FROM 'shopify'
     OR integration_type IS DISTINCT FROM 'commerce'
  THEN
    RAISE EXCEPTION
      'Shopify customer rate policy requires a Shopify commerce account';
  END IF;

  SELECT activation.state INTO activation_state
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id;

  IF activation_state IS NULL
     OR activation_state NOT IN ('shadow', 'active')
  THEN
    RAISE EXCEPTION
      'Shopify customer rate policy requires Operations Shadow or Active';
  END IF;

  IF activation_state = 'shadow'
     AND (
       NEW.status NOT IN ('simulated', 'removed')
       OR NEW.provider_state IS DISTINCT FROM 'not_written'
     )
  THEN
    RAISE EXCEPTION
      'Operations Shadow customer rate policy must remain provider-write-free';
  END IF;
  IF activation_state = 'active'
     AND (
       NEW.status = 'simulated'
       OR NEW.provider_state = 'not_written'
       OR NEW.shadow_duration_minutes IS NOT NULL
       OR NEW.shadow_expires_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION
      'Only Operations Shadow may record a simulated customer rate policy';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_operations_shopify_customer_rate_policy_write_trigger
  ON operations_shopify_customer_rate_policies;
CREATE TRIGGER
  validate_operations_shopify_customer_rate_policy_write_trigger
BEFORE INSERT OR UPDATE
ON operations_shopify_customer_rate_policies
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_shopify_customer_rate_policy_write();

COMMENT ON TABLE operations_shopify_customer_rate_policies IS
  'Paginated, unbounded-by-customer-count Shopify Customer policy intent. Shadow rows are zero-write simulations; Active rows are blocked until separately authorized provider enforcement exists.';

COMMENT ON COLUMN
  operations_shopify_customer_rate_policies.shopify_customer_gid IS
  'Exact canonical Shopify Customer GID; customer names, email addresses, phone numbers, and addresses are never persisted in this table.';

COMMENT ON COLUMN
  operations_shopify_customer_rate_policies.provider_state IS
  'Explicit provider enforcement state. Migration 0178 creates only not_written or write_blocked rows and authorizes zero Shopify mutations.';

COMMENT ON COLUMN
  operations_shopify_customer_rate_policies.shadow_expires_at IS
  'Fail-closed end of the bounded Shadow proof. Simulated policies last 15 through 240 whole minutes and default to 60 minutes when not explicitly configured.';
