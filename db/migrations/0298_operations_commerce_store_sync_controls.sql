-- Store synchronization is an account-scoped read control. It is deliberately
-- independent from provider-write authority and from Shopify CarrierService.

CREATE TABLE IF NOT EXISTS operations_commerce_store_sync_controls (
  organization_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  desired_state text NOT NULL CHECK (desired_state IN ('running', 'paused')),
  explicit_choice boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  reason text NOT NULL CHECK (
    length(btrim(reason)) BETWEEN 1 AND 500
    AND reason !~ '[[:cntrl:]]'
  ),
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id),
  CONSTRAINT operations_commerce_store_sync_controls_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT
);

COMMENT ON TABLE operations_commerce_store_sync_controls IS
  'Per-commerce-account read synchronization control. It grants no provider-write or callback authority.';

CREATE TABLE IF NOT EXISTS operations_commerce_store_sync_change_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'
  ),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  previous_desired_state text NOT NULL
    CHECK (previous_desired_state IN ('running', 'paused')),
  desired_state text NOT NULL CHECK (desired_state IN ('running', 'paused')),
  resulting_revision bigint NOT NULL CHECK (resulting_revision > 0),
  reason text NOT NULL CHECK (
    length(btrim(reason)) BETWEEN 1 AND 500
    AND reason !~ '[[:cntrl:]]'
  ),
  actor_email text NOT NULL CHECK (length(btrim(actor_email)) BETWEEN 3 AND 320),
  response_json text NOT NULL CHECK (
    length(response_json) BETWEEN 2 AND 8192
    AND jsonb_typeof(response_json::jsonb) = 'object'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_store_sync_receipts_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_commerce_store_sync_controls(
      organization_id, integration_account_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_store_sync_receipts_idempotency_unique
    UNIQUE (organization_id, integration_account_id, idempotency_key)
);

COMMENT ON TABLE operations_commerce_store_sync_change_receipts IS
  'Append-only idempotency and revision evidence for Store sync changes.';

-- Automatic provider reads acquire a short durable lease before any network
-- request. Store sync changes serialize only with this acquisition, not with
-- the network request itself. This lets Desired=Paused commit promptly while
-- an already-acquired read is reported as draining. Heartbeats keep a live
-- read visible; an abandoned process ages out conservatively.
CREATE TABLE IF NOT EXISTS operations_commerce_store_sync_read_leases (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  authority_kind text NOT NULL,
  read_kind text NOT NULL,
  intent_fingerprint_sha256 text NOT NULL,
  control_revision bigint NOT NULL,
  activation_revision bigint NOT NULL,
  acquired_by text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  captured_at timestamptz,
  released_at timestamptz,
  release_reason text,
  CONSTRAINT operations_commerce_store_sync_read_leases_authority_valid CHECK (
    authority_kind IN ('automatic', 'manual_read_only')
  ),
  CONSTRAINT operations_commerce_store_sync_read_leases_kind_valid CHECK (
    read_kind IN (
    'catalog_intake',
    'order_history',
    'order_revision',
    'shopify_webhook_hydration',
    'shopify_inventory',
    'product_image_import',
    'faire_inventory_poll'
  )),
  CONSTRAINT operations_commerce_store_sync_read_leases_intent_valid CHECK (
    intent_fingerprint_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT operations_commerce_store_sync_read_leases_revision_valid CHECK (
    control_revision > 0 AND activation_revision > 0
  ),
  CONSTRAINT operations_commerce_store_sync_read_leases_actor_valid CHECK (
    length(btrim(acquired_by)) BETWEEN 1 AND 200
    AND acquired_by !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_commerce_store_sync_read_leases_release_valid CHECK (
    release_reason IN ('completed', 'failed', 'expired')
  ),
  CONSTRAINT operations_commerce_store_sync_read_leases_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_commerce_store_sync_controls(
      organization_id, integration_account_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_store_sync_read_leases_time_valid CHECK (
    heartbeat_at >= acquired_at
    AND expires_at > heartbeat_at
    AND expires_at <= heartbeat_at + interval '65 seconds'
    AND (
      captured_at IS NULL
      OR (captured_at >= acquired_at AND captured_at < expires_at)
    )
    AND (
      (released_at IS NULL AND release_reason IS NULL)
      OR (
        released_at IS NOT NULL
        AND release_reason IS NOT NULL
        AND released_at >= acquired_at
      )
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_commerce_store_sync_read_leases_intent_unique
ON operations_commerce_store_sync_read_leases (
  organization_id,
  integration_account_id,
  authority_kind,
  read_kind,
  intent_fingerprint_sha256
);

CREATE INDEX IF NOT EXISTS
  operations_commerce_store_sync_read_leases_active_idx
ON operations_commerce_store_sync_read_leases (
  organization_id,
  integration_account_id,
  expires_at
)
WHERE released_at IS NULL;

COMMENT ON TABLE operations_commerce_store_sync_read_leases IS
  'Durable bounded automatic/manual provider-read intent leases. Automatic active leases make an explicit Pause report draining; neither lease kind grants provider-write authority.';

ALTER TABLE operations_commerce_intake_read_intents
  ADD COLUMN IF NOT EXISTS provider_read_authority text;
UPDATE operations_commerce_intake_read_intents
SET provider_read_authority = 'automatic'
WHERE provider_read_authority IS NULL;
ALTER TABLE operations_commerce_intake_read_intents
  ALTER COLUMN provider_read_authority SET NOT NULL;
ALTER TABLE operations_commerce_intake_read_intents
  DROP CONSTRAINT IF EXISTS commerce_intake_read_intents_authority_valid;
ALTER TABLE operations_commerce_intake_read_intents
  ADD CONSTRAINT commerce_intake_read_intents_authority_valid CHECK (
    provider_read_authority IN ('automatic', 'manual_read_only')
  );

ALTER TABLE operations_commerce_product_image_observation_sets
  ADD COLUMN IF NOT EXISTS provider_read_authority text;
UPDATE operations_commerce_product_image_observation_sets
SET provider_read_authority = 'automatic'
WHERE provider_read_authority IS NULL;
ALTER TABLE operations_commerce_product_image_observation_sets
  ALTER COLUMN provider_read_authority SET NOT NULL;
ALTER TABLE operations_commerce_product_image_observation_sets
  DROP CONSTRAINT IF EXISTS ops_commerce_image_set_authority_valid;
ALTER TABLE operations_commerce_product_image_observation_sets
  ADD CONSTRAINT ops_commerce_image_set_authority_valid CHECK (
    provider_read_authority IN ('automatic', 'manual_read_only')
  );

ALTER TABLE operations_commerce_product_image_import_jobs
  ADD COLUMN IF NOT EXISTS provider_read_authority text;
UPDATE operations_commerce_product_image_import_jobs job
SET provider_read_authority = observation_set.provider_read_authority
FROM operations_commerce_product_image_observations observation
JOIN operations_commerce_product_image_observation_sets observation_set
  ON observation_set.organization_id = observation.organization_id
 AND observation_set.integration_account_id =
       observation.integration_account_id
 AND observation_set.id = observation.observation_set_id
WHERE job.organization_id = observation.organization_id
  AND job.integration_account_id = observation.integration_account_id
  AND job.observation_id = observation.id
  AND job.provider_read_authority IS NULL;
UPDATE operations_commerce_product_image_import_jobs
SET provider_read_authority = 'automatic'
WHERE provider_read_authority IS NULL;
ALTER TABLE operations_commerce_product_image_import_jobs
  ALTER COLUMN provider_read_authority SET NOT NULL;
ALTER TABLE operations_commerce_product_image_import_jobs
  DROP CONSTRAINT IF EXISTS ops_commerce_image_job_authority_valid;
ALTER TABLE operations_commerce_product_image_import_jobs
  ADD CONSTRAINT ops_commerce_image_job_authority_valid CHECK (
    provider_read_authority IN ('automatic', 'manual_read_only')
  );

CREATE OR REPLACE FUNCTION
  guard_operations_commerce_product_image_read_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.provider_read_authority
           IS DISTINCT FROM OLD.provider_read_authority THEN
    RAISE EXCEPTION 'Commerce product image read authority is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_operations_commerce_image_set_authority_write
  ON operations_commerce_product_image_observation_sets;
CREATE TRIGGER guard_operations_commerce_image_set_authority_write
BEFORE UPDATE ON operations_commerce_product_image_observation_sets
FOR EACH ROW EXECUTE FUNCTION
  guard_operations_commerce_product_image_read_authority();

DROP TRIGGER IF EXISTS guard_operations_commerce_image_job_authority_write
  ON operations_commerce_product_image_import_jobs;
CREATE TRIGGER guard_operations_commerce_image_job_authority_write
BEFORE UPDATE ON operations_commerce_product_image_import_jobs
FOR EACH ROW EXECUTE FUNCTION
  guard_operations_commerce_product_image_read_authority();

INSERT INTO operations_commerce_store_sync_controls (
  organization_id,
  integration_account_id,
  desired_state,
  explicit_choice,
  revision,
  reason,
  created_by,
  updated_by,
  created_at,
  updated_at
)
SELECT
  account.organization_id,
  account.id,
  CASE
    WHEN activation.state IN ('shadow', 'active') THEN 'running'
    ELSE 'paused'
  END,
  false,
  1,
  CASE
    WHEN activation.state IN ('shadow', 'active')
      THEN 'Initialized from the current Operations mode as Running'
    ELSE 'Initialized from the current Operations mode as Paused'
  END,
  account.created_by,
  account.updated_by,
  now(),
  now()
FROM operations_integration_accounts account
LEFT JOIN operations_activation_scopes activation
  ON activation.organization_id = account.organization_id
WHERE account.integration_type = 'commerce'
  AND account.provider IN ('shopify', 'faire')
ON CONFLICT (organization_id, integration_account_id) DO NOTHING;

-- Every later SQL function and trigger resolves this exact account predicate.
CREATE OR REPLACE FUNCTION operations_commerce_store_sync_effective_reason(
  requested_organization_id uuid,
  requested_integration_account_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN activation.state = 'disabled'
      THEN 'OPERATIONS_DISABLED_OVERRIDE'
    WHEN activation.state = 'frozen'
      THEN 'OPERATIONS_FROZEN_OVERRIDE'
    WHEN control.integration_account_id IS NULL
      THEN 'STORE_SYNC_CONTROL_MISSING'
    WHEN account.status <> 'active'
      THEN 'STORE_SYNC_ACCOUNT_UNAVAILABLE'
    WHEN control.explicit_choice AND control.desired_state = 'running'
      THEN 'STORE_SYNC_EXPLICIT_RUNNING'
    WHEN control.explicit_choice AND control.desired_state = 'paused'
         AND EXISTS (
           SELECT 1
           FROM operations_commerce_store_sync_read_leases lease
           WHERE lease.organization_id = account.organization_id
             AND lease.integration_account_id = account.id
             AND lease.authority_kind = 'automatic'
             AND lease.released_at IS NULL
             AND lease.expires_at > clock_timestamp()
         )
      THEN 'STORE_SYNC_EXPLICIT_PAUSED_DRAINING'
    WHEN control.explicit_choice AND control.desired_state = 'paused'
      THEN 'STORE_SYNC_EXPLICIT_PAUSED'
    WHEN activation.state = 'shadow'
      THEN 'STORE_SYNC_LEGACY_SHADOW_RUNNING'
    WHEN activation.state = 'active'
      THEN 'STORE_SYNC_LEGACY_ACTIVE_RUNNING'
    ELSE 'STORE_SYNC_LEGACY_READ_ONLY_PAUSED'
  END
  FROM operations_integration_accounts account
  JOIN operations_activation_scopes activation
    ON activation.organization_id = account.organization_id
  LEFT JOIN operations_commerce_store_sync_controls control
    ON control.organization_id = account.organization_id
   AND control.integration_account_id = account.id
  WHERE account.organization_id = requested_organization_id
    AND account.id = requested_integration_account_id
    AND account.integration_type = 'commerce'
    AND account.provider IN ('shopify', 'faire')
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION operations_commerce_store_sync_is_running(
  requested_organization_id uuid,
  requested_integration_account_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    operations_commerce_store_sync_effective_reason(
      requested_organization_id,
      requested_integration_account_id
    ) IN (
      'STORE_SYNC_EXPLICIT_RUNNING',
      'STORE_SYNC_LEGACY_SHADOW_RUNNING',
      'STORE_SYNC_LEGACY_ACTIVE_RUNNING'
    ),
    false
  )
$$;

CREATE OR REPLACE FUNCTION operations_commerce_provider_read_authority_is_current(
  requested_organization_id uuid,
  requested_integration_account_id uuid,
  requested_authority text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT CASE requested_authority
    WHEN 'automatic' THEN
      operations_commerce_store_sync_is_running(
        requested_organization_id,
        requested_integration_account_id
      )
    WHEN 'manual_read_only' THEN EXISTS (
      SELECT 1
      FROM operations_integration_accounts account
      JOIN operations_commerce_store_sync_controls control
        ON control.organization_id = account.organization_id
       AND control.integration_account_id = account.id
      JOIN operations_activation_scopes activation
        ON activation.organization_id = account.organization_id
      WHERE account.organization_id = requested_organization_id
        AND account.id = requested_integration_account_id
        AND account.integration_type = 'commerce'
        AND account.provider IN ('shopify', 'faire')
        AND account.status = 'active'
        AND activation.state NOT IN ('disabled', 'frozen')
    )
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION
  operations_commerce_product_image_read_authority_is_current(
    requested_organization_id uuid,
    requested_integration_account_id uuid,
    requested_provider text,
    requested_credential_generation integer,
    requested_authority text
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_integration_accounts account
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
     AND credential.external_account_id = account.external_account_id
    WHERE account.organization_id = requested_organization_id
      AND account.id = requested_integration_account_id
      AND account.integration_type = 'commerce'
      AND account.provider = requested_provider
      AND account.status = 'active'
      AND account.commerce_credential_generation =
            requested_credential_generation
      AND credential.credential_version = requested_credential_generation
      AND credential.verification_status = 'verified'
      AND operations_commerce_provider_read_authority_is_current(
        account.organization_id,
        account.id,
        requested_authority
      )
  )
$$;

CREATE OR REPLACE FUNCTION seed_operations_commerce_store_sync_control()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_activation_state text;
BEGIN
  IF NEW.integration_type <> 'commerce'
     OR NEW.provider NOT IN ('shopify', 'faire') THEN
    RETURN NEW;
  END IF;

  SELECT state INTO current_activation_state
  FROM operations_activation_scopes
  WHERE organization_id = NEW.organization_id;

  INSERT INTO operations_commerce_store_sync_controls (
    organization_id,
    integration_account_id,
    desired_state,
    explicit_choice,
    revision,
    reason,
    created_by,
    updated_by
  ) VALUES (
    NEW.organization_id,
    NEW.id,
    CASE
      WHEN current_activation_state IN ('shadow', 'active') THEN 'running'
      ELSE 'paused'
    END,
    false,
    1,
    CASE
      WHEN current_activation_state IN ('shadow', 'active')
        THEN 'Initialized from the current Operations mode as Running'
      ELSE 'Initialized from the current Operations mode as Paused'
    END,
    NEW.created_by,
    NEW.updated_by
  )
  ON CONFLICT (organization_id, integration_account_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- These append/lineage triggers contain extensive immutable-evidence logic.
-- Replace only their exact legacy activation joins; abort the migration if a
-- prior migration changed the expected source instead of weakening any other
-- credential, lease, policy, authority, revision, or write fence.
DO $store_sync_read_lineage$
DECLARE
  definition text;
  legacy text;
  replacement text;
  expected_count integer;
  actual_count integer;
BEGIN
  definition := pg_get_functiondef(
    'public.protect_commerce_order_sync_session_lineage()'::regprocedure
  );
  legacy := $legacy$
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id$legacy$;
  replacement := $replacement$
       JOIN operations_commerce_store_sync_controls store_sync
         ON store_sync.organization_id = account.organization_id
        AND store_sync.integration_account_id = account.id
        AND public.operations_commerce_store_sync_is_running(
          account.organization_id, account.id
        )$replacement$;
  expected_count := 1;
  actual_count := (length(definition) - length(replace(definition, legacy, '')))
    / length(legacy);
  IF actual_count <> expected_count THEN
    RAISE EXCEPTION 'Unexpected commerce order session activation lineage source';
  END IF;
  definition := replace(definition, legacy, replacement);
  legacy := $legacy$         AND activation.state IN ('shadow', 'active')$legacy$;
  actual_count := (length(definition) - length(replace(definition, legacy, '')))
    / length(legacy);
  IF actual_count <> 1 THEN
    RAISE EXCEPTION 'Unexpected commerce order session activation state source';
  END IF;
  definition := replace(definition, legacy, '');
  EXECUTE definition;

  definition := pg_get_functiondef(
    'public.protect_commerce_order_observation_lineage()'::regprocedure
  );
  legacy := $legacy$
         JOIN operations_activation_scopes activation
           ON activation.organization_id = session.organization_id
          AND activation.state IN ('shadow', 'active')$legacy$;
  replacement := $replacement$
         JOIN operations_commerce_store_sync_controls store_sync
           ON store_sync.organization_id = session.organization_id
          AND store_sync.integration_account_id = session.integration_account_id
          AND public.operations_commerce_store_sync_is_running(
            session.organization_id, session.integration_account_id
          )$replacement$;
  actual_count := (length(definition) - length(replace(definition, legacy, '')))
    / length(legacy);
  IF actual_count <> 1 THEN
    RAISE EXCEPTION 'Unexpected backfill observation activation lineage source';
  END IF;
  definition := replace(definition, legacy, replacement);
  legacy := $legacy$
         JOIN operations_activation_scopes activation
           ON activation.organization_id = target.organization_id
          AND activation.state IN ('shadow', 'active')$legacy$;
  replacement := $replacement$
         JOIN operations_commerce_store_sync_controls store_sync
           ON store_sync.organization_id = target.organization_id
          AND store_sync.integration_account_id = target.integration_account_id
          AND public.operations_commerce_store_sync_is_running(
            target.organization_id, target.integration_account_id
          )$replacement$;
  actual_count := (length(definition) - length(replace(definition, legacy, '')))
    / length(legacy);
  IF actual_count <> 1 THEN
    RAISE EXCEPTION 'Unexpected webhook observation activation lineage source';
  END IF;
  definition := replace(definition, legacy, replacement);
  EXECUTE definition;

  definition := pg_get_functiondef(
    'public.commerce_order_observation_accepts_children(uuid,uuid)'::regprocedure
  );
  legacy := $legacy$
    JOIN operations_activation_scopes activation
      ON activation.organization_id = session.organization_id
     AND activation.state IN ('shadow', 'active')$legacy$;
  replacement := $replacement$
    JOIN operations_commerce_store_sync_controls store_sync
      ON store_sync.organization_id = session.organization_id
     AND store_sync.integration_account_id = session.integration_account_id
     AND public.operations_commerce_store_sync_is_running(
       session.organization_id, session.integration_account_id
     )$replacement$;
  actual_count := (length(definition) - length(replace(definition, legacy, '')))
    / length(legacy);
  IF actual_count <> 1 THEN
    RAISE EXCEPTION 'Unexpected backfill child activation lineage source';
  END IF;
  definition := replace(definition, legacy, replacement);
  legacy := $legacy$
    JOIN operations_activation_scopes activation
      ON activation.organization_id = target.organization_id
     AND activation.state IN ('shadow', 'active')$legacy$;
  replacement := $replacement$
    JOIN operations_commerce_store_sync_controls store_sync
      ON store_sync.organization_id = target.organization_id
     AND store_sync.integration_account_id = target.integration_account_id
     AND public.operations_commerce_store_sync_is_running(
       target.organization_id, target.integration_account_id
     )$replacement$;
  actual_count := (length(definition) - length(replace(definition, legacy, '')))
    / length(legacy);
  IF actual_count <> 1 THEN
    RAISE EXCEPTION 'Unexpected webhook child activation lineage source';
  END IF;
  definition := replace(definition, legacy, replacement);
  EXECUTE definition;

  definition := pg_get_functiondef(
    'public.protect_shopify_order_webhook_read()'::regprocedure
  );
  legacy := $legacy$
    JOIN operations_activation_scopes activation
      ON activation.organization_id = target.organization_id
     AND activation.state IN ('shadow', 'active')$legacy$;
  replacement := $replacement$
    JOIN operations_commerce_store_sync_controls store_sync
      ON store_sync.organization_id = target.organization_id
     AND store_sync.integration_account_id = target.integration_account_id
     AND public.operations_commerce_store_sync_is_running(
       target.organization_id, target.integration_account_id
     )$replacement$;
  actual_count := (length(definition) - length(replace(definition, legacy, '')))
    / length(legacy);
  IF actual_count <> 1 THEN
    RAISE EXCEPTION 'Unexpected webhook read activation lineage source';
  END IF;
  definition := replace(definition, legacy, replacement);
  EXECUTE definition;

  definition := pg_get_functiondef(
    'public.protect_shopify_order_webhook_target()'::regprocedure
  );
  legacy := $legacy$
         JOIN operations_activation_scopes activation
           ON activation.organization_id = account.organization_id
          AND activation.state IN ('shadow', 'active')$legacy$;
  replacement := $replacement$
         JOIN operations_commerce_store_sync_controls store_sync
           ON store_sync.organization_id = account.organization_id
          AND store_sync.integration_account_id = account.id
          AND public.operations_commerce_store_sync_is_running(
            account.organization_id, account.id
          )$replacement$;
  expected_count := 2;
  actual_count := (length(definition) - length(replace(definition, legacy, '')))
    / length(legacy);
  IF actual_count <> expected_count THEN
    RAISE EXCEPTION 'Unexpected webhook target activation lineage source';
  END IF;
  definition := replace(definition, legacy, replacement);
  EXECUTE definition;
END;
$store_sync_read_lineage$;

CREATE OR REPLACE FUNCTION
  guard_operations_commerce_product_image_binding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  exact_projection boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Commerce product image bindings cannot be deleted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.operations_commerce_product_image_import_jobs authority_job
    WHERE authority_job.organization_id = NEW.organization_id
      AND authority_job.integration_account_id = NEW.integration_account_id
      AND authority_job.id = NEW.latest_import_job_id
      AND authority_job.provider = NEW.provider
      AND authority_job.credential_generation = NEW.credential_generation
      AND public.operations_commerce_product_image_read_authority_is_current(
        NEW.organization_id,
        NEW.integration_account_id,
        NEW.provider,
        NEW.credential_generation,
        authority_job.provider_read_authority
      )
  ) THEN
    RAISE EXCEPTION
      'Commerce product image binding requires the current verified account credential and exact provider-read authority';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'Commerce product image binding must start at row version one';
    END IF;
  ELSE
    IF ROW(
      NEW.id,
      NEW.global_id,
      NEW.organization_id,
      NEW.integration_account_id,
      NEW.provider,
      NEW.credential_generation,
      NEW.external_product_id,
      NEW.image_identity_sha256,
      NEW.pipeline_id,
      NEW.product_id,
      NEW.created_by,
      NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.id,
      OLD.global_id,
      OLD.organization_id,
      OLD.integration_account_id,
      OLD.provider,
      OLD.credential_generation,
      OLD.external_product_id,
      OLD.image_identity_sha256,
      OLD.pipeline_id,
      OLD.product_id,
      OLD.created_by,
      OLD.created_at
    ) THEN
      RAISE EXCEPTION 'Commerce product image binding scope is immutable';
    END IF;
    IF NEW.row_version <> OLD.row_version + 1 THEN
      RAISE EXCEPTION
        'Commerce product image binding row version must advance by one';
    END IF;
    IF NEW.latest_observation_revision < OLD.latest_observation_revision
      OR (
        NEW.latest_observation_revision = OLD.latest_observation_revision
        AND NEW.latest_import_job_generation <=
              OLD.latest_import_job_generation
      )
    THEN
      RAISE EXCEPTION
        'Commerce product image binding observation/job generation cannot regress or replay';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION
        'Commerce product image binding update timestamp cannot regress';
    END IF;
    IF NEW.lifecycle_state = 'inactive'
      AND ROW(
        NEW.pipeline_id,
        NEW.product_id,
        NEW.activation_revision,
        NEW.asset_id,
        NEW.latest_import_job_id,
        NEW.latest_import_job_generation
      )
            IS DISTINCT FROM
          ROW(
            OLD.pipeline_id,
            OLD.product_id,
            OLD.activation_revision,
            OLD.asset_id,
            OLD.latest_import_job_id,
            OLD.latest_import_job_generation
          )
    THEN
      RAISE EXCEPTION
        'Inactive commerce product image binding asset lineage is immutable';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.operations_commerce_product_image_observations observation
    JOIN public.operations_commerce_product_image_observation_sets
      observation_set
      ON observation_set.organization_id = observation.organization_id
     AND observation_set.integration_account_id =
           observation.integration_account_id
     AND observation_set.id = observation.observation_set_id
    JOIN public.crm_product_image_assets asset
      ON asset.organization_id = NEW.organization_id
     AND asset.pipeline_id = NEW.pipeline_id
     AND asset.product_id = NEW.product_id
     AND asset.id = NEW.asset_id
    WHERE observation.organization_id = NEW.organization_id
      AND observation.integration_account_id = NEW.integration_account_id
      AND observation.provider = NEW.provider
      AND observation.credential_generation = NEW.credential_generation
      AND observation.external_product_id = NEW.external_product_id
      AND observation.image_identity_sha256 = NEW.image_identity_sha256
      AND observation.id = NEW.latest_observation_id
      AND observation.observation_revision =
            NEW.latest_observation_revision
      AND observation.observation_set_id = NEW.latest_observation_set_id
      AND observation.provider_image_id IS NOT DISTINCT FROM
            NEW.provider_image_id
      AND observation.locator_sha256 = NEW.locator_sha256
      AND observation.image_sequence = NEW.provider_sequence
      AND (
        observation.alt_text IS NULL
        OR observation.alt_text = NEW.effective_alt_text
      )
      AND (
        (
          NEW.lifecycle_state = 'active'
          AND observation.lifecycle_state = 'active'
          AND EXISTS (
            SELECT 1
            FROM public.operations_activation_scopes activation
            WHERE activation.organization_id = NEW.organization_id
              AND activation.data_pipeline_id = NEW.pipeline_id
              AND activation.revision = NEW.activation_revision
          )
          AND public.operations_commerce_store_sync_is_running(
            NEW.organization_id,
            NEW.integration_account_id
          )
          AND public.operations_commerce_product_image_observation_is_current_active(
            NEW.organization_id,
            NEW.latest_observation_id
          )
          AND public.operations_commerce_product_image_job_fences_are_current(
            NEW.organization_id,
            NEW.latest_import_job_id
          )
          AND EXISTS (
            SELECT 1
            FROM public.operations_commerce_product_image_asset_provenance
              provenance
            JOIN public.operations_commerce_product_image_import_jobs
              import_job
              ON import_job.organization_id = provenance.organization_id
             AND import_job.id = provenance.import_job_id
             AND import_job.job_generation =
                   provenance.import_job_generation
            WHERE provenance.organization_id = NEW.organization_id
              AND provenance.integration_account_id =
                    NEW.integration_account_id
              AND provenance.provider = NEW.provider
              AND provenance.credential_generation =
                    NEW.credential_generation
              AND provenance.observation_id = NEW.latest_observation_id
              AND provenance.import_job_id = NEW.latest_import_job_id
              AND provenance.import_job_generation =
                    NEW.latest_import_job_generation
              AND provenance.external_product_id = NEW.external_product_id
              AND provenance.image_identity_sha256 =
                    NEW.image_identity_sha256
              AND provenance.pipeline_id = NEW.pipeline_id
              AND provenance.product_id = NEW.product_id
              AND provenance.activation_revision = NEW.activation_revision
              AND provenance.asset_id = NEW.asset_id
              AND import_job.state = 'succeeded'
              AND import_job.activation_revision = NEW.activation_revision
          )
        )
        OR (
          NEW.lifecycle_state = 'inactive'
          AND observation.lifecycle_state = 'removed'
          AND observation_set.image_set_complete = true
          AND NOT EXISTS (
            SELECT 1
            FROM public.operations_commerce_product_image_observations later
            WHERE later.organization_id = observation.organization_id
              AND later.integration_account_id =
                    observation.integration_account_id
              AND later.credential_generation =
                    observation.credential_generation
              AND later.external_product_id = observation.external_product_id
              AND later.image_identity_sha256 =
                    observation.image_identity_sha256
              AND later.observation_revision >
                    observation.observation_revision
          )
        )
      )
  ) INTO exact_projection;

  IF NOT exact_projection THEN
    RAISE EXCEPTION
      'Commerce product image binding does not match current observation, exact fan-out target, asset, and lifecycle evidence';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS seed_operations_commerce_store_sync_control_write
  ON operations_integration_accounts;
CREATE TRIGGER seed_operations_commerce_store_sync_control_write
AFTER INSERT ON operations_integration_accounts
FOR EACH ROW EXECUTE FUNCTION seed_operations_commerce_store_sync_control();

CREATE OR REPLACE FUNCTION protect_operations_commerce_store_sync_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Store sync change receipts are append-only';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_store_sync_receipt_write
  ON operations_commerce_store_sync_change_receipts;
CREATE TRIGGER protect_operations_commerce_store_sync_receipt_write
BEFORE UPDATE OR DELETE ON operations_commerce_store_sync_change_receipts
FOR EACH ROW EXECUTE FUNCTION protect_operations_commerce_store_sync_receipt();

CREATE OR REPLACE FUNCTION guard_operations_commerce_store_sync_read_lease()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Store sync provider-read lease evidence cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.released_at IS NOT NULL
       OR NEW.release_reason IS NOT NULL
       OR NEW.heartbeat_at IS DISTINCT FROM NEW.acquired_at
       OR NOT operations_commerce_provider_read_authority_is_current(
         NEW.organization_id,
         NEW.integration_account_id,
         NEW.authority_kind
       ) THEN
      RAISE EXCEPTION
        'Store sync provider-read lease requires current exact authority';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.id,
      NEW.organization_id,
      NEW.integration_account_id,
      NEW.authority_kind,
      NEW.read_kind,
      NEW.intent_fingerprint_sha256,
      NEW.control_revision,
      NEW.activation_revision,
      NEW.acquired_by,
      NEW.acquired_at
    ) IS DISTINCT FROM ROW(
      OLD.id,
      OLD.organization_id,
      OLD.integration_account_id,
      OLD.authority_kind,
      OLD.read_kind,
      OLD.intent_fingerprint_sha256,
      OLD.control_revision,
      OLD.activation_revision,
      OLD.acquired_by,
      OLD.acquired_at
    ) THEN
      RAISE EXCEPTION 'Store sync provider-read lease identity is immutable';
    END IF;
    IF OLD.released_at IS NOT NULL AND ROW(
      NEW.heartbeat_at,
      NEW.expires_at,
      NEW.captured_at,
      NEW.released_at,
      NEW.release_reason
    ) IS DISTINCT FROM ROW(
      OLD.heartbeat_at,
      OLD.expires_at,
      OLD.captured_at,
      OLD.released_at,
      OLD.release_reason
    ) THEN
      RAISE EXCEPTION 'Released Store sync provider-read lease evidence is immutable';
    END IF;
    IF OLD.captured_at IS NOT NULL
       AND NEW.captured_at IS DISTINCT FROM OLD.captured_at THEN
      RAISE EXCEPTION 'Store sync provider-read capture evidence is immutable';
    END IF;
    IF OLD.captured_at IS NULL
       AND NEW.captured_at IS NOT NULL
       AND (
         NEW.released_at IS NOT NULL
         OR NEW.captured_at < OLD.acquired_at
         OR NEW.captured_at >= OLD.expires_at
       ) THEN
      RAISE EXCEPTION 'Store sync provider-read capture requires a live lease';
    END IF;
    IF OLD.released_at IS NULL AND NEW.released_at IS NULL
       AND ROW(NEW.heartbeat_at, NEW.expires_at)
             IS DISTINCT FROM ROW(OLD.heartbeat_at, OLD.expires_at)
       AND (NEW.heartbeat_at <= OLD.heartbeat_at
            OR NEW.expires_at <= OLD.expires_at) THEN
      RAISE EXCEPTION 'Store sync provider-read lease heartbeat must advance';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_operations_commerce_store_sync_read_lease_write
  ON operations_commerce_store_sync_read_leases;
CREATE TRIGGER guard_operations_commerce_store_sync_read_lease_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_commerce_store_sync_read_leases
FOR EACH ROW EXECUTE FUNCTION guard_operations_commerce_store_sync_read_lease();

CREATE OR REPLACE FUNCTION validate_operations_commerce_store_sync_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.integration_account_id
            IS DISTINCT FROM OLD.integration_account_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION
        'Store sync control identity and creation evidence are immutable';
    END IF;
    IF NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION
        'Store sync control revision must advance by exactly one';
    END IF;
    IF NEW.explicit_choice IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'A changed Store sync control must retain an explicit choice';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM operations_integration_accounts account
    WHERE account.organization_id = NEW.organization_id
      AND account.id = NEW.integration_account_id
      AND account.integration_type = 'commerce'
      AND account.provider IN ('shopify', 'faire')
  ) THEN
    RAISE EXCEPTION
      'Store sync controls require an exact Shopify or Faire commerce account';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_commerce_store_sync_identity_write
  ON operations_commerce_store_sync_controls;
CREATE TRIGGER validate_operations_commerce_store_sync_identity_write
BEFORE INSERT OR UPDATE
ON operations_commerce_store_sync_controls
FOR EACH ROW EXECUTE FUNCTION validate_operations_commerce_store_sync_identity();

-- Inventory provider reads use the exact credential, configuration,
-- warehouse, and Store sync control. They intentionally do not inherit either
-- the CarrierService activation-revision latch or its callback registration
-- authority. A shadow-simulated config is sufficient for inventory reads only;
-- it grants no callback or provider-write capability.
CREATE OR REPLACE FUNCTION operations_shopify_inventory_read_config_is_ready(
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
    JOIN operations_warehouses warehouse
      ON warehouse.organization_id = config.organization_id
     AND warehouse.id = config.warehouse_id
    WHERE config.organization_id = requested_organization_id
      AND config.id = requested_config_id
      AND account.integration_type = 'commerce'
      AND account.provider = 'shopify'
      AND account.status = 'active'
      AND account.commerce_credential_generation = config.credential_generation
      AND credential.credential_version = config.credential_generation
      AND credential.external_account_id = account.external_account_id
      AND credential.verification_status = 'verified'
      AND warehouse.status = 'active'
      AND public.operations_commerce_store_sync_is_running(
        account.organization_id,
        account.id
      )
      AND config.registration_state IN ('registered', 'shadow_simulated')
  )
$$;

COMMENT ON FUNCTION operations_shopify_inventory_read_config_is_ready(
  uuid, uuid
) IS
  'Inventory-read-only readiness: exact Shopify credential/config/warehouse and Store sync; registered and shadow-simulated configs are accepted for inventory reads only and grant no callback or provider-write authority.';

CREATE OR REPLACE FUNCTION
  operations_commerce_product_image_account_is_current(
    requested_organization_id uuid,
    requested_integration_account_id uuid,
    requested_provider text,
    requested_credential_generation integer
  )
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.operations_integration_accounts account
    JOIN public.operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
     AND credential.external_account_id = account.external_account_id
    WHERE account.organization_id = requested_organization_id
      AND account.id = requested_integration_account_id
      AND account.integration_type = 'commerce'
      AND account.provider = requested_provider
      AND account.status = 'active'
      AND account.commerce_credential_generation =
            requested_credential_generation
      AND requested_credential_generation > 0
      AND credential.credential_version =
            account.commerce_credential_generation
      AND credential.verification_status = 'verified'
      AND public.operations_commerce_store_sync_is_running(
        account.organization_id,
        account.id
      )
  )
$$;

-- Existing mirrored image data remains readable while Store sync is Paused.
-- This predicate proves durable account/credential lineage only; live import
-- authority continues to use operations_commerce_product_image_account_is_current.
CREATE OR REPLACE FUNCTION
  operations_commerce_product_image_account_lineage_is_current(
    requested_organization_id uuid,
    requested_integration_account_id uuid,
    requested_provider text,
    requested_credential_generation integer
  )
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.operations_integration_accounts account
    JOIN public.operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
     AND credential.external_account_id = account.external_account_id
    WHERE account.organization_id = requested_organization_id
      AND account.id = requested_integration_account_id
      AND account.integration_type = 'commerce'
      AND account.provider = requested_provider
      AND account.status = 'active'
      AND account.commerce_credential_generation =
            requested_credential_generation
      AND requested_credential_generation > 0
      AND credential.credential_version =
            account.commerce_credential_generation
      AND credential.verification_status = 'verified'
  )
$$;

CREATE OR REPLACE FUNCTION
  operations_commerce_product_image_mapping_targets(
    requested_organization_id uuid,
    requested_integration_account_id uuid,
    requested_provider text,
    requested_external_product_id text
  )
RETURNS TABLE (
  pipeline_id uuid,
  product_id uuid,
  canonical_product_mapping_id uuid,
  target_mapping_count integer,
  target_mapping_fingerprint_sha256 text,
  activation_revision integer,
  product_name text,
  mapping_count integer,
  mapping_fingerprint_sha256 text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH channel_scope AS (
    SELECT DISTINCT
      channel_state.id AS channel_state_id,
      channel_state.product_id AS channel_product_id,
      channel_state.product_mapping_id AS channel_product_mapping_id,
      channel_state.external_product_id AS channel_external_product_id,
      channel_state.external_variant_id AS channel_external_variant_id,
      mapping.id AS mapping_id,
      mapping.pipeline_id AS mapping_pipeline_id,
      mapping.product_id AS mapping_product_id,
      mapping.external_product_id AS mapping_external_product_id,
      mapping.external_variant_id AS mapping_external_variant_id,
      mapping.mapping_method,
      mapping.active AS mapping_active,
      activation.revision AS activation_revision,
      product.id AS resolved_product_id,
      product.name AS product_name
    FROM public.operations_product_channel_states channel_state
    LEFT JOIN public.operations_product_mappings mapping
      ON mapping.organization_id = channel_state.organization_id
     AND mapping.integration_account_id =
           channel_state.integration_account_id
     AND mapping.pipeline_id = channel_state.pipeline_id
     AND mapping.id = channel_state.product_mapping_id
     AND mapping.product_id = channel_state.product_id
    LEFT JOIN public.crm_products product
      ON product.pipeline_id = mapping.pipeline_id
     AND product.id = mapping.product_id
    LEFT JOIN public.operations_activation_scopes activation
      ON activation.organization_id = mapping.organization_id
     AND activation.data_pipeline_id = mapping.pipeline_id
    WHERE channel_state.organization_id = requested_organization_id
      AND channel_state.integration_account_id =
            requested_integration_account_id
      AND channel_state.provider = requested_provider
      AND channel_state.external_product_id =
            requested_external_product_id
  ),
  scope_validity AS (
    SELECT
      count(*) FILTER (
        WHERE channel_scope.mapping_active = true
          AND channel_scope.activation_revision IS NOT NULL
      ) > 0
      AND bool_and(COALESCE(
        channel_scope.channel_product_id IS NOT NULL
        AND channel_scope.channel_product_mapping_id IS NOT NULL
        AND channel_scope.mapping_id IS NOT NULL
        AND channel_scope.mapping_active = true
        AND channel_scope.mapping_external_product_id =
              channel_scope.channel_external_product_id
        AND channel_scope.mapping_external_variant_id =
              channel_scope.channel_external_variant_id
        AND channel_scope.resolved_product_id IS NOT NULL
        AND channel_scope.activation_revision IS NOT NULL,
        false
      )) FILTER (
        WHERE channel_scope.mapping_active = true
          AND channel_scope.activation_revision IS NOT NULL
      ) AS complete_exact_scope
    FROM channel_scope
  ),
  exact_mapping AS (
    SELECT DISTINCT
      channel_scope.mapping_id AS id,
      channel_scope.mapping_pipeline_id AS pipeline_id,
      channel_scope.mapping_product_id AS product_id,
      channel_scope.mapping_external_product_id AS external_product_id,
      channel_scope.mapping_external_variant_id AS external_variant_id,
      channel_scope.mapping_method,
      channel_scope.activation_revision,
      channel_scope.product_name
    FROM channel_scope
    WHERE channel_scope.mapping_active = true
      AND channel_scope.activation_revision IS NOT NULL
      AND (SELECT complete_exact_scope FROM scope_validity)
  ),
  mapping_scope AS (
    SELECT
      exact_mapping.pipeline_id,
      exact_mapping.activation_revision,
      count(*)::integer AS exact_mapping_count,
      encode(
        digest(
          convert_to(
            string_agg(
              concat_ws(
                chr(31),
                exact_mapping.id::text,
                exact_mapping.pipeline_id::text,
                exact_mapping.product_id::text,
                COALESCE(exact_mapping.external_product_id, ''),
                COALESCE(exact_mapping.external_variant_id, ''),
                exact_mapping.mapping_method
              ),
              chr(30) ORDER BY exact_mapping.id::text
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) AS mapping_hash
    FROM exact_mapping
    GROUP BY
      exact_mapping.pipeline_id,
      exact_mapping.activation_revision
  ),
  target AS (
    SELECT
      exact_mapping.pipeline_id,
      exact_mapping.product_id,
      exact_mapping.activation_revision,
      (min(exact_mapping.id::text))::uuid AS canonical_mapping_id,
      count(*)::integer AS exact_mapping_count,
      encode(
        digest(
          convert_to(
            string_agg(
              concat_ws(
                chr(31),
                exact_mapping.id::text,
                exact_mapping.pipeline_id::text,
                exact_mapping.product_id::text,
                COALESCE(exact_mapping.external_product_id, ''),
                COALESCE(exact_mapping.external_variant_id, ''),
                exact_mapping.mapping_method
              ),
              chr(30) ORDER BY exact_mapping.id::text
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) AS mapping_hash,
      min(exact_mapping.product_name) AS resolved_product_name
    FROM exact_mapping
    GROUP BY
      exact_mapping.pipeline_id,
      exact_mapping.product_id,
      exact_mapping.activation_revision
  )
  SELECT
    target.pipeline_id,
    target.product_id,
    target.canonical_mapping_id,
    target.exact_mapping_count,
    target.mapping_hash,
    target.activation_revision,
    target.resolved_product_name,
    mapping_scope.exact_mapping_count,
    mapping_scope.mapping_hash
  FROM target
  JOIN mapping_scope
    ON mapping_scope.pipeline_id = target.pipeline_id
   AND mapping_scope.activation_revision = target.activation_revision
  ORDER BY
    target.pipeline_id::text,
    target.activation_revision,
    target.product_id::text,
    target.canonical_mapping_id::text
$$;

CREATE OR REPLACE FUNCTION
  operations_commerce_product_image_job_fences_are_current(
    requested_organization_id uuid,
    requested_job_id uuid
  )
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_row public.operations_commerce_product_image_import_jobs%ROWTYPE;
  resolution record;
BEGIN
  SELECT * INTO job_row
  FROM public.operations_commerce_product_image_import_jobs job
  WHERE job.organization_id = requested_organization_id
    AND job.id = requested_job_id;

  IF NOT FOUND
    OR job_row.pipeline_id IS NULL
    OR NOT public.operations_commerce_provider_read_authority_is_current(
      job_row.organization_id,
      job_row.integration_account_id,
      job_row.provider_read_authority
    )
    OR NOT public.operations_commerce_product_image_observation_is_current_active(
      job_row.organization_id,
      job_row.observation_id
    )
  THEN
    RETURN false;
  END IF;

  SELECT * INTO resolution
  FROM public.operations_commerce_product_image_mapping_resolution(
    job_row.organization_id,
    job_row.integration_account_id,
    job_row.provider,
    job_row.external_product_id
  );

  RETURN resolution.resolution_count = 1
    AND resolution.pipeline_id IS NOT DISTINCT FROM job_row.pipeline_id
    AND resolution.product_id IS NOT DISTINCT FROM job_row.product_id
    AND resolution.canonical_product_mapping_id
          IS NOT DISTINCT FROM job_row.product_mapping_id
    AND resolution.mapping_count IS NOT DISTINCT FROM job_row.mapping_count
    AND resolution.mapping_fingerprint_sha256
          IS NOT DISTINCT FROM job_row.mapping_fingerprint_sha256
    AND resolution.activation_revision
          IS NOT DISTINCT FROM job_row.activation_revision;
END;
$$;

-- Read/display validity deliberately excludes Store sync. New provider fetch,
-- capture, and binding mutations continue to use the live job-fence function.
CREATE OR REPLACE FUNCTION
  operations_commerce_product_image_projection_fences_are_current(
    requested_organization_id uuid,
    requested_job_id uuid
  )
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_row public.operations_commerce_product_image_import_jobs%ROWTYPE;
  resolution record;
BEGIN
  SELECT * INTO job_row
  FROM public.operations_commerce_product_image_import_jobs job
  WHERE job.organization_id = requested_organization_id
    AND job.id = requested_job_id;

  IF NOT FOUND
    OR job_row.pipeline_id IS NULL
    OR NOT public.operations_commerce_product_image_observation_is_current_active(
      job_row.organization_id,
      job_row.observation_id
    )
  THEN
    RETURN false;
  END IF;

  SELECT * INTO resolution
  FROM public.operations_commerce_product_image_mapping_resolution(
    job_row.organization_id,
    job_row.integration_account_id,
    job_row.provider,
    job_row.external_product_id
  );

  RETURN resolution.resolution_count = 1
    AND resolution.pipeline_id IS NOT DISTINCT FROM job_row.pipeline_id
    AND resolution.product_id IS NOT DISTINCT FROM job_row.product_id
    AND resolution.canonical_product_mapping_id
          IS NOT DISTINCT FROM job_row.product_mapping_id
    AND resolution.mapping_count IS NOT DISTINCT FROM job_row.mapping_count
    AND resolution.mapping_fingerprint_sha256
          IS NOT DISTINCT FROM job_row.mapping_fingerprint_sha256;
END;
$$;
