-- Read-only Faire channel-inventory observations.
--
-- Faire exposes inventory only for caller-supplied variant IDs or SKUs and
-- does not document inventory webhooks. These rows therefore preserve a
-- scheduled selector-poll observation of the Faire listing. They are never a
-- ClawPilot/WMS physical-inventory authority and cannot project inventory.

CREATE TABLE IF NOT EXISTS operations_faire_inventory_poll_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  activation_revision integer NOT NULL CHECK (activation_revision > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'processing', 'failed',
      'succeeded', 'cancelled', 'dead'
    )),
  selector_after text,
  variants_seen bigint NOT NULL DEFAULT 0 CHECK (variants_seen >= 0),
  quantities_observed bigint NOT NULL DEFAULT 0
    CHECK (quantities_observed >= 0),
  untracked_observations bigint NOT NULL DEFAULT 0
    CHECK (untracked_observations >= 0),
  missing_observations bigint NOT NULL DEFAULT 0
    CHECK (missing_observations >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 8
    CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  lock_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  recovered_from_job_id uuid,
  recovery_reason_hash text,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(result_summary) = 'object'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_faire_inventory_poll_jobs_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_faire_inventory_poll_jobs_org_account_id_unique
    UNIQUE (organization_id, integration_account_id, id),
  CONSTRAINT operations_faire_inventory_poll_jobs_recovery_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, recovered_from_job_id
    ) REFERENCES operations_faire_inventory_poll_jobs(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_faire_inventory_poll_jobs_recovery_pair_valid CHECK (
    (recovered_from_job_id IS NULL) = (recovery_reason_hash IS NULL)
  ),
  CONSTRAINT operations_faire_inventory_poll_jobs_recovery_hash_valid CHECK (
    recovery_reason_hash IS NULL
    OR recovery_reason_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT operations_faire_inventory_poll_jobs_selector_valid CHECK (
    selector_after IS NULL
    OR (
      length(btrim(selector_after)) BETWEEN 1 AND 512
      AND selector_after !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT operations_faire_inventory_poll_jobs_error_valid CHECK (
    last_error_code IS NULL
    OR (
      length(btrim(last_error_code)) BETWEEN 3 AND 128
      AND last_error_code ~ '^[A-Z][A-Z0-9_]+$'
    )
  ),
  CONSTRAINT operations_faire_inventory_poll_jobs_lease_valid CHECK (
    (
      status = 'processing'
      AND locked_at IS NOT NULL
      AND locked_by IS NOT NULL
      AND lock_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR (
      status <> 'processing'
      AND locked_at IS NULL
      AND locked_by IS NULL
      AND lock_token IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT operations_faire_inventory_poll_jobs_completion_valid CHECK (
    (status IN ('succeeded', 'cancelled', 'dead'))
      = (completed_at IS NOT NULL)
  ),
  CONSTRAINT operations_faire_inventory_poll_jobs_attempt_limit CHECK (
    attempt_count <= max_attempts
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_faire_inventory_poll_active_account
  ON operations_faire_inventory_poll_jobs (
    organization_id, integration_account_id
  )
  WHERE status IN ('pending', 'processing', 'failed');

CREATE INDEX IF NOT EXISTS idx_operations_faire_inventory_poll_claim
  ON operations_faire_inventory_poll_jobs (
    status, available_at, created_at, id
  )
  WHERE status IN ('pending', 'processing', 'failed');

CREATE INDEX IF NOT EXISTS idx_operations_faire_inventory_poll_history
  ON operations_faire_inventory_poll_jobs (
    organization_id, integration_account_id, created_at DESC, id DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_faire_inventory_poll_recovery_once
  ON operations_faire_inventory_poll_jobs (recovered_from_job_id)
  WHERE recovered_from_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS operations_faire_inventory_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  poll_job_id uuid NOT NULL,
  channel_state_id uuid NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  external_variant_id text NOT NULL,
  provider_record_state text NOT NULL
    CHECK (provider_record_state IN ('present', 'missing')),
  on_hand_state text NOT NULL
    CHECK (on_hand_state IN ('quantity', 'untracked', 'missing')),
  on_hand_quantity bigint,
  committed_state text NOT NULL
    CHECK (committed_state IN ('quantity', 'untracked', 'missing')),
  committed_quantity bigint,
  available_state text NOT NULL
    CHECK (available_state IN ('quantity', 'untracked', 'missing')),
  available_quantity bigint,
  authority text NOT NULL DEFAULT 'faire_channel_listing_observation'
    CHECK (authority = 'faire_channel_listing_observation'),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  wms_projection_applied boolean NOT NULL DEFAULT false
    CHECK (wms_projection_applied = false),
  provider_writes integer NOT NULL DEFAULT 0 CHECK (provider_writes = 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_faire_inventory_observations_job_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, poll_job_id
    ) REFERENCES operations_faire_inventory_poll_jobs(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_faire_inventory_observations_channel_fkey
    FOREIGN KEY (organization_id, channel_state_id)
    REFERENCES operations_product_channel_states(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_faire_inventory_observations_variant_valid CHECK (
    length(btrim(external_variant_id)) BETWEEN 1 AND 512
    AND external_variant_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_faire_inventory_observations_on_hand_valid CHECK (
    (on_hand_state = 'quantity') = (on_hand_quantity IS NOT NULL)
  ),
  CONSTRAINT operations_faire_inventory_observations_committed_valid CHECK (
    (committed_state = 'quantity') = (committed_quantity IS NOT NULL)
    AND (committed_quantity IS NULL OR committed_quantity >= 0)
  ),
  CONSTRAINT operations_faire_inventory_observations_available_valid CHECK (
    (available_state = 'quantity') = (available_quantity IS NOT NULL)
  ),
  CONSTRAINT operations_faire_inventory_observations_missing_valid CHECK (
    provider_record_state <> 'missing'
    OR (
      on_hand_state = 'missing'
      AND committed_state = 'missing'
      AND available_state = 'missing'
    )
  ),
  CONSTRAINT operations_faire_inventory_observations_job_variant_unique
    UNIQUE (poll_job_id, channel_state_id)
);

CREATE INDEX IF NOT EXISTS idx_operations_faire_inventory_observation_latest
  ON operations_faire_inventory_observations (
    organization_id, integration_account_id,
    external_variant_id, observed_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION protect_operations_faire_inventory_observation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Faire inventory observations are append-only and cannot be changed';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_faire_inventory_observation
  ON operations_faire_inventory_observations;
CREATE TRIGGER protect_operations_faire_inventory_observation
BEFORE UPDATE OR DELETE ON operations_faire_inventory_observations
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_faire_inventory_observation();

COMMENT ON TABLE operations_faire_inventory_poll_jobs IS
  'Leased, retry-bounded read-only Faire selector sweeps; no webhook or provider write is implied.';

COMMENT ON TABLE operations_faire_inventory_observations IS
  'Append-only Faire channel-listing quantities. These rows are not WMS inventory authority and cannot project stock.';

COMMENT ON COLUMN operations_faire_inventory_observations.authority IS
  'Explicitly limits the observation to the Faire marketplace listing; it is not physical warehouse authority.';
