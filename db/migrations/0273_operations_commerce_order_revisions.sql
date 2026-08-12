-- Immutable, exact-provider evidence for revisions to already-promoted
-- Shopify and Faire orders. Material changes block execution. The only
-- provider revision this migration may project onto a canonical order is an
-- exact provider cancellation accepted by a manager while the order remains
-- wholly unstarted; arbitrary header and line changes remain review-only.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('gcor', 'operations.commerce_order_revision_observation', 'Commerce order revision observation'),
  ('gcod', 'operations.commerce_order_revision_disposition', 'Commerce order revision disposition')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_commerce_order_revision_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  order_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  accepted_source_hash text NOT NULL CHECK (accepted_source_hash ~ '^[a-f0-9]{64}$'),
  latest_source_hash text CHECK (latest_source_hash IS NULL OR latest_source_hash ~ '^[a-f0-9]{64}$'),
  latest_observation_id uuid,
  material_state text NOT NULL DEFAULT 'current' CHECK (
    material_state IN ('current', 'review_required', 'provider_cancelled', 'provider_fulfilled')
  ),
  claim_state text NOT NULL DEFAULT 'pending' CHECK (
    claim_state IN ('pending', 'processing', 'ready', 'failed', 'dead_letter')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  next_check_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  locked_by text,
  lock_token uuid,
  locked_until timestamptz,
  last_error_code text,
  row_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_order_revision_targets_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_order_revision_targets_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_order_revision_targets_order_unique
    UNIQUE (organization_id, order_id),
  CONSTRAINT operations_commerce_order_revision_targets_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_commerce_order_revision_targets_lock_valid CHECK (
    (claim_state = 'processing' AND locked_by IS NOT NULL AND lock_token IS NOT NULL AND locked_until IS NOT NULL)
    OR (claim_state <> 'processing' AND locked_by IS NULL AND lock_token IS NULL AND locked_until IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS operations_commerce_order_revision_targets_claim_idx
  ON operations_commerce_order_revision_targets(provider, next_check_at, id)
  WHERE claim_state IN ('pending', 'ready', 'failed');

CREATE TABLE IF NOT EXISTS operations_commerce_order_revision_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcor'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  target_id uuid NOT NULL,
  order_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  external_order_id text NOT NULL,
  source_revision text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  revision_hash text NOT NULL CHECK (revision_hash ~ '^[a-f0-9]{64}$'),
  normalized_snapshot jsonb NOT NULL CHECK (jsonb_typeof(normalized_snapshot) = 'object'),
  canonical_row_version bigint NOT NULL CHECK (canonical_row_version >= 0),
  provider_read_count integer NOT NULL CHECK (provider_read_count BETWEEN 1 AND 4),
  provider_write_count integer NOT NULL CHECK (provider_write_count = 0),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_order_revision_observations_global_valid CHECK (
    global_id ~ '^gcor(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_commerce_order_revision_observations_global_unique UNIQUE (global_id),
  CONSTRAINT operations_commerce_order_revision_observations_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_commerce_order_revision_observations_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_order_revision_observations_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_order_revision_observations_target_fkey
    FOREIGN KEY (organization_id, target_id)
    REFERENCES operations_commerce_order_revision_targets(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_order_revision_observations_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_order_revision_observations_source_unique
    UNIQUE (organization_id, integration_account_id, order_id, source_hash),
  CONSTRAINT operations_commerce_order_revision_observations_identity_valid CHECK (
    length(btrim(external_order_id)) BETWEEN 1 AND 512
    AND length(btrim(source_revision)) BETWEEN 1 AND 512
  )
);

CREATE TABLE IF NOT EXISTS operations_commerce_order_revision_dispositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcod'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  target_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  order_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  action text NOT NULL CHECK (action = 'cancel_unstarted_order'),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  expected_order_row_version bigint NOT NULL CHECK (expected_order_row_version >= 0),
  previous_status text NOT NULL CHECK (previous_status = 'imported'),
  resulting_status text NOT NULL CHECK (resulting_status = 'cancelled'),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  revision_hash text NOT NULL CHECK (revision_hash ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL,
  provider_read_count integer NOT NULL CHECK (provider_read_count BETWEEN 1 AND 4),
  provider_write_count integer NOT NULL CHECK (provider_write_count = 0),
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  cancelled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_order_revision_dispositions_global_valid CHECK (
    global_id ~ '^gcod(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_commerce_order_revision_dispositions_global_unique UNIQUE (global_id),
  CONSTRAINT operations_commerce_order_revision_dispositions_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_commerce_order_revision_dispositions_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_order_revision_dispositions_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_order_revision_dispositions_target_fkey
    FOREIGN KEY (organization_id, target_id)
    REFERENCES operations_commerce_order_revision_targets(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_order_revision_dispositions_observation_fkey
    FOREIGN KEY (organization_id, observation_id)
    REFERENCES operations_commerce_order_revision_observations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_order_revision_dispositions_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_order_revision_dispositions_idempotency_unique
    UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_commerce_order_revision_dispositions_order_unique
    UNIQUE (organization_id, order_id),
  CONSTRAINT operations_commerce_order_revision_dispositions_text_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
    AND length(btrim(reason)) BETWEEN 1 AND 500
    AND reason !~ '[[:cntrl:]]'
  )
);

ALTER TABLE operations_commerce_order_revision_targets
  DROP CONSTRAINT IF EXISTS operations_commerce_order_revision_targets_latest_observation_fkey;
ALTER TABLE operations_commerce_order_revision_targets
  ADD CONSTRAINT operations_commerce_order_revision_targets_latest_observation_fkey
  FOREIGN KEY (organization_id, latest_observation_id)
  REFERENCES operations_commerce_order_revision_observations(organization_id, id)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION reject_operations_commerce_order_revision_observation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commerce order revision observations are immutable';
END;
$$;

DROP TRIGGER IF EXISTS operations_commerce_order_revision_observations_immutable
  ON operations_commerce_order_revision_observations;
CREATE TRIGGER operations_commerce_order_revision_observations_immutable
BEFORE UPDATE OR DELETE ON operations_commerce_order_revision_observations
FOR EACH ROW EXECUTE FUNCTION reject_operations_commerce_order_revision_observation_mutation();

CREATE OR REPLACE FUNCTION reject_operations_commerce_order_revision_disposition_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commerce order revision dispositions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS operations_commerce_order_revision_dispositions_immutable
  ON operations_commerce_order_revision_dispositions;
CREATE TRIGGER operations_commerce_order_revision_dispositions_immutable
BEFORE UPDATE OR DELETE ON operations_commerce_order_revision_dispositions
FOR EACH ROW EXECUTE FUNCTION reject_operations_commerce_order_revision_disposition_mutation();

CREATE OR REPLACE FUNCTION protect_operations_commerce_order_revision_exception_resolution()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.exception_type = 'commerce_order_revision_required'
     AND NEW.status IN ('resolved', 'dismissed')
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       NEW.status = 'resolved'
       AND (
         COALESCE(
           NEW.details->>'resolution' = 'provider_revision_current',
           false
         )
         OR EXISTS (
           SELECT 1
           FROM operations_commerce_order_revision_dispositions disposition
           WHERE disposition.organization_id = NEW.organization_id
             AND disposition.order_id = NEW.order_id
         )
       )
     )
  THEN
    RAISE EXCEPTION
      'commerce order revision exceptions require immutable disposition evidence';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS operations_commerce_order_revision_exception_resolution_guard
  ON operations_exceptions;
CREATE TRIGGER operations_commerce_order_revision_exception_resolution_guard
BEFORE UPDATE OF status ON operations_exceptions
FOR EACH ROW EXECUTE FUNCTION protect_operations_commerce_order_revision_exception_resolution();

CREATE OR REPLACE FUNCTION enqueue_operations_commerce_order_revision_target()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_provider IN ('shopify', 'faire')
     AND NEW.status NOT IN ('shipped', 'cancelled') THEN
    INSERT INTO operations_commerce_order_revision_targets (
      organization_id, integration_account_id, order_id, provider,
      accepted_source_hash, checked_at, next_check_at
    ) VALUES (
      NEW.organization_id, NEW.integration_account_id, NEW.id, NEW.source_provider,
      CASE
        WHEN COALESCE(NEW.source_payload->>'sourceHash', '') ~ '^[a-f0-9]{64}$'
        THEN NEW.source_payload->>'sourceHash'
        ELSE encode(digest(convert_to(NEW.source_payload::text, 'UTF8'), 'sha256'), 'hex')
      END,
      NEW.imported_at,
      now()
    ) ON CONFLICT (organization_id, order_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS operations_orders_enqueue_commerce_revision_target
  ON operations_orders;
CREATE TRIGGER operations_orders_enqueue_commerce_revision_target
AFTER INSERT ON operations_orders
FOR EACH ROW EXECUTE FUNCTION enqueue_operations_commerce_order_revision_target();

INSERT INTO operations_commerce_order_revision_targets (
  organization_id, integration_account_id, order_id, provider,
  accepted_source_hash, checked_at, next_check_at
)
SELECT
  order_row.organization_id,
  order_row.integration_account_id,
  order_row.id,
  order_row.source_provider,
  CASE
    WHEN COALESCE(order_row.source_payload->>'sourceHash', '') ~ '^[a-f0-9]{64}$'
    THEN order_row.source_payload->>'sourceHash'
    ELSE encode(digest(convert_to(order_row.source_payload::text, 'UTF8'), 'sha256'), 'hex')
  END,
  order_row.imported_at,
  now()
FROM operations_orders order_row
WHERE order_row.source_provider IN ('shopify', 'faire')
  AND order_row.status NOT IN ('shipped', 'cancelled')
ON CONFLICT (organization_id, order_id) DO NOTHING;
