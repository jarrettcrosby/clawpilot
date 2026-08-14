-- Manager-triggered exact refresh and local-only application of a rigorously
-- bounded Shopify/Faire revision.  This migration is intentionally additive:
-- 0273 observations and cancellation dispositions remain immutable and no
-- historical row is assigned authority it did not retain at creation time.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('gcrr', 'operations.commerce_order_revision_read', 'Commerce order revision exact read'),
  ('gcoa', 'operations.commerce_order_revision_application', 'Commerce order revision application'),
  ('gcal', 'operations.commerce_order_revision_application_line', 'Commerce order revision application line')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_commerce_order_revision_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcrr'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  target_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  order_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  revision_hash text NOT NULL CHECK (revision_hash ~ '^[a-f0-9]{64}$'),
  canonical_row_version bigint NOT NULL CHECK (canonical_row_version >= 0),
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('scheduled', 'manager')),
  command_receipt_id uuid,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  party_snapshot_ciphertext bytea,
  party_snapshot_iv bytea,
  party_snapshot_tag bytea,
  party_snapshot_hash text,
  party_content_fingerprint text,
  party_snapshot_key_id text,
  party_snapshot_encryption_version integer,
  ship_to_snapshot_ciphertext bytea,
  ship_to_snapshot_iv bytea,
  ship_to_snapshot_tag bytea,
  ship_to_snapshot_hash text,
  ship_to_content_fingerprint text,
  ship_to_snapshot_key_id text,
  ship_to_snapshot_encryption_version integer,
  provider_read_count integer NOT NULL CHECK (provider_read_count BETWEEN 1 AND 4),
  provider_write_count integer NOT NULL CHECK (provider_write_count = 0),
  observed_at timestamptz NOT NULL,
  protected_snapshot_expires_at timestamptz NOT NULL,
  protected_snapshot_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ocr_reads_global_valid CHECK (
    global_id ~ '^gcrr(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT ocr_reads_global_unique UNIQUE (global_id),
  CONSTRAINT ocr_reads_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT ocr_reads_registry_fk
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT ocr_reads_account_fk
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ocr_reads_target_fk
    FOREIGN KEY (organization_id, target_id)
    REFERENCES operations_commerce_order_revision_targets(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ocr_reads_observation_fk
    FOREIGN KEY (organization_id, observation_id)
    REFERENCES operations_commerce_order_revision_observations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ocr_reads_order_fk
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ocr_reads_receipt_fk
    FOREIGN KEY (organization_id, command_receipt_id)
    REFERENCES operations_command_receipts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ocr_reads_receipt_unique
    UNIQUE (organization_id, command_receipt_id),
  CONSTRAINT ocr_reads_trigger_valid CHECK (
    (trigger_kind = 'manager' AND command_receipt_id IS NOT NULL AND actor_email IS NOT NULL)
    OR (trigger_kind = 'scheduled' AND command_receipt_id IS NULL AND actor_email IS NULL)
  ),
  CONSTRAINT ocr_reads_party_snapshot_valid CHECK (
    (
      party_snapshot_ciphertext IS NULL
      AND party_snapshot_iv IS NULL
      AND party_snapshot_tag IS NULL
      AND (
        (party_snapshot_hash IS NULL
          AND party_content_fingerprint IS NULL
          AND party_snapshot_key_id IS NULL
          AND party_snapshot_encryption_version IS NULL)
        OR (protected_snapshot_purged_at IS NOT NULL
          AND party_snapshot_hash IS NOT NULL
          AND party_snapshot_hash ~ '^[a-f0-9]{64}$'
          AND party_content_fingerprint IS NOT NULL
          AND party_content_fingerprint ~ '^[a-f0-9]{64}$'
          AND party_snapshot_key_id IS NOT NULL
          AND party_snapshot_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
          AND party_snapshot_encryption_version IS NOT NULL
          AND party_snapshot_encryption_version = 1)
      )
    ) OR (
      party_snapshot_ciphertext IS NOT NULL
      AND octet_length(party_snapshot_ciphertext) BETWEEN 1 AND 65536
      AND party_snapshot_iv IS NOT NULL
      AND octet_length(party_snapshot_iv) = 12
      AND party_snapshot_tag IS NOT NULL
      AND octet_length(party_snapshot_tag) = 16
      AND party_snapshot_hash IS NOT NULL
      AND party_snapshot_hash ~ '^[a-f0-9]{64}$'
      AND party_content_fingerprint IS NOT NULL
      AND party_content_fingerprint ~ '^[a-f0-9]{64}$'
      AND party_snapshot_key_id IS NOT NULL
      AND party_snapshot_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND party_snapshot_encryption_version IS NOT NULL
      AND party_snapshot_encryption_version = 1
    )
  ),
  CONSTRAINT ocr_reads_ship_to_snapshot_valid CHECK (
    (
      ship_to_snapshot_ciphertext IS NULL
      AND ship_to_snapshot_iv IS NULL
      AND ship_to_snapshot_tag IS NULL
      AND (
        (ship_to_snapshot_hash IS NULL
          AND ship_to_content_fingerprint IS NULL
          AND ship_to_snapshot_key_id IS NULL
          AND ship_to_snapshot_encryption_version IS NULL)
        OR (protected_snapshot_purged_at IS NOT NULL
          AND ship_to_snapshot_hash IS NOT NULL
          AND ship_to_snapshot_hash ~ '^[a-f0-9]{64}$'
          AND ship_to_content_fingerprint IS NOT NULL
          AND ship_to_content_fingerprint ~ '^[a-f0-9]{64}$'
          AND ship_to_snapshot_key_id IS NOT NULL
          AND ship_to_snapshot_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
          AND ship_to_snapshot_encryption_version IS NOT NULL
          AND ship_to_snapshot_encryption_version = 1)
      )
    ) OR (
      ship_to_snapshot_ciphertext IS NOT NULL
      AND octet_length(ship_to_snapshot_ciphertext) BETWEEN 1 AND 65536
      AND ship_to_snapshot_iv IS NOT NULL
      AND octet_length(ship_to_snapshot_iv) = 12
      AND ship_to_snapshot_tag IS NOT NULL
      AND octet_length(ship_to_snapshot_tag) = 16
      AND ship_to_snapshot_hash IS NOT NULL
      AND ship_to_snapshot_hash ~ '^[a-f0-9]{64}$'
      AND ship_to_content_fingerprint IS NOT NULL
      AND ship_to_content_fingerprint ~ '^[a-f0-9]{64}$'
      AND ship_to_snapshot_key_id IS NOT NULL
      AND ship_to_snapshot_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND ship_to_snapshot_encryption_version IS NOT NULL
      AND ship_to_snapshot_encryption_version = 1
    )
  ),
  CONSTRAINT ocr_reads_protected_retention_valid CHECK (
    protected_snapshot_expires_at > created_at
    AND protected_snapshot_expires_at <= created_at + interval '30 days'
    AND (
      protected_snapshot_purged_at IS NULL
      OR protected_snapshot_purged_at >= created_at
    )
  )
);

CREATE INDEX IF NOT EXISTS ocr_reads_latest_idx
  ON operations_commerce_order_revision_reads (
    organization_id, order_id, observed_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION validate_ocr_observation_lineage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_commerce_order_revision_targets target
    JOIN operations_orders order_row
      ON order_row.organization_id = target.organization_id
     AND order_row.id = target.order_id
    JOIN operations_integration_accounts account
      ON account.organization_id = target.organization_id
     AND account.id = target.integration_account_id
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    WHERE target.organization_id = NEW.organization_id
      AND target.id = NEW.target_id
      AND target.integration_account_id = NEW.integration_account_id
      AND target.order_id = NEW.order_id
      AND target.provider = NEW.provider
      AND order_row.integration_account_id = NEW.integration_account_id
      AND order_row.source_provider = NEW.provider
      AND order_row.external_order_id = NEW.external_order_id
      AND order_row.row_version = NEW.canonical_row_version
      AND account.provider = NEW.provider
      AND account.integration_type = 'commerce'
      AND account.commerce_credential_generation = NEW.credential_generation
      AND credential.credential_version = NEW.credential_generation
      AND credential.verification_status = 'verified'
      AND NEW.normalized_snapshot->>'provider' = NEW.provider
      AND NEW.normalized_snapshot->>'accountGlobalId' = account.global_id
      AND NEW.normalized_snapshot->>'integrationAccountId' =
          NEW.integration_account_id::text
      AND NEW.normalized_snapshot->>'externalAccountId' =
          account.external_account_id
      AND NEW.normalized_snapshot->>'credentialVersion' =
          NEW.credential_generation::text
      AND NEW.normalized_snapshot->>'canonicalOrderGlobalId' =
          order_row.global_id
      AND NEW.normalized_snapshot->>'canonicalOrderRowVersion' =
          NEW.canonical_row_version::text
      AND NEW.normalized_snapshot #>> '{order,externalOrderId}' =
          NEW.external_order_id
      AND NEW.normalized_snapshot #>> '{order,sourceHash}' = NEW.source_hash
  ) THEN
    RAISE EXCEPTION 'commerce order revision observation lineage is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ocr_observations_lineage_guard
  ON operations_commerce_order_revision_observations;
CREATE TRIGGER ocr_observations_lineage_guard
BEFORE INSERT ON operations_commerce_order_revision_observations
FOR EACH ROW EXECUTE FUNCTION validate_ocr_observation_lineage();

CREATE OR REPLACE FUNCTION validate_ocr_read_lineage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_commerce_order_revision_targets target
    JOIN operations_orders order_row
      ON order_row.organization_id = target.organization_id
     AND order_row.id = target.order_id
    JOIN operations_integration_accounts account
      ON account.organization_id = target.organization_id
     AND account.id = target.integration_account_id
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN operations_commerce_order_revision_observations observation
      ON observation.organization_id = target.organization_id
     AND observation.id = NEW.observation_id
    LEFT JOIN operations_command_receipts receipt
      ON receipt.organization_id = NEW.organization_id
     AND receipt.id = NEW.command_receipt_id
    WHERE target.organization_id = NEW.organization_id
      AND target.id = NEW.target_id
      AND target.integration_account_id = NEW.integration_account_id
      AND target.order_id = NEW.order_id
      AND target.provider = NEW.provider
      AND order_row.integration_account_id = NEW.integration_account_id
      AND order_row.source_provider = NEW.provider
      AND order_row.row_version = NEW.canonical_row_version
      AND account.provider = NEW.provider
      AND account.integration_type = 'commerce'
      AND account.commerce_credential_generation = NEW.credential_generation
      AND credential.credential_version = NEW.credential_generation
      AND credential.verification_status = 'verified'
      AND observation.integration_account_id = NEW.integration_account_id
      AND observation.target_id = NEW.target_id
      AND observation.order_id = NEW.order_id
      AND observation.provider = NEW.provider
      AND observation.source_hash = NEW.source_hash
      AND observation.revision_hash = NEW.revision_hash
      AND observation.provider_write_count = 0
      AND (
        (NEW.trigger_kind = 'scheduled' AND receipt.id IS NULL)
        OR (
          NEW.trigger_kind = 'manager'
          AND receipt.command_type =
              'operations.commerce_order_revision.refresh'
          AND receipt.actor_email = NEW.actor_email
          AND receipt.target_global_id = order_row.global_id
          AND receipt.status = 'processing'
        )
      )
  ) THEN
    RAISE EXCEPTION 'commerce order revision exact read lineage is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ocr_reads_lineage_guard
  ON operations_commerce_order_revision_reads;
CREATE TRIGGER ocr_reads_lineage_guard
BEFORE INSERT ON operations_commerce_order_revision_reads
FOR EACH ROW EXECUTE FUNCTION validate_ocr_read_lineage();

ALTER TABLE operations_commerce_order_revision_targets
  ADD COLUMN IF NOT EXISTS latest_read_id uuid,
  ADD COLUMN IF NOT EXISTS accepted_observation_id uuid,
  ADD COLUMN IF NOT EXISTS accepted_read_id uuid,
  ADD COLUMN IF NOT EXISTS accepted_revision_hash text;

ALTER TABLE operations_commerce_order_revision_targets
  DROP CONSTRAINT IF EXISTS ocr_targets_latest_read_fk;
ALTER TABLE operations_commerce_order_revision_targets
  ADD CONSTRAINT ocr_targets_latest_read_fk
  FOREIGN KEY (organization_id, latest_read_id)
  REFERENCES operations_commerce_order_revision_reads(organization_id, id)
  ON DELETE RESTRICT;

ALTER TABLE operations_commerce_order_revision_targets
  DROP CONSTRAINT IF EXISTS ocr_targets_accepted_observation_fk;
ALTER TABLE operations_commerce_order_revision_targets
  ADD CONSTRAINT ocr_targets_accepted_observation_fk
  FOREIGN KEY (organization_id, accepted_observation_id)
  REFERENCES operations_commerce_order_revision_observations(organization_id, id)
  ON DELETE RESTRICT;

ALTER TABLE operations_commerce_order_revision_targets
  DROP CONSTRAINT IF EXISTS ocr_targets_accepted_read_fk;
ALTER TABLE operations_commerce_order_revision_targets
  ADD CONSTRAINT ocr_targets_accepted_read_fk
  FOREIGN KEY (organization_id, accepted_read_id)
  REFERENCES operations_commerce_order_revision_reads(organization_id, id)
  ON DELETE RESTRICT;

ALTER TABLE operations_commerce_order_revision_targets
  DROP CONSTRAINT IF EXISTS ocr_targets_accepted_revision_hash_valid;
ALTER TABLE operations_commerce_order_revision_targets
  ADD CONSTRAINT ocr_targets_accepted_revision_hash_valid CHECK (
    accepted_revision_hash IS NULL OR accepted_revision_hash ~ '^[a-f0-9]{64}$'
  );

ALTER TABLE operations_commerce_order_revision_dispositions
  ADD COLUMN IF NOT EXISTS read_id uuid;

ALTER TABLE operations_commerce_order_revision_dispositions
  DROP CONSTRAINT IF EXISTS ocr_dispositions_read_fk;
ALTER TABLE operations_commerce_order_revision_dispositions
  ADD CONSTRAINT ocr_dispositions_read_fk
  FOREIGN KEY (organization_id, read_id)
  REFERENCES operations_commerce_order_revision_reads(organization_id, id)
  ON DELETE RESTRICT;

-- Shared by cancellation, manager preflight, and local Apply.  Define it
-- before the cancellation guard so direct evidence inserts cannot bypass the
-- same zero-downstream authority used by the application transaction.
CREATE OR REPLACE FUNCTION ocr_order_has_zero_downstream(
  p_organization_id uuid,
  p_order_id uuid
)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT (
    EXISTS (SELECT 1 FROM operations_fulfillment_plans row
            WHERE row.organization_id = p_organization_id AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_reservations row
               WHERE row.organization_id = p_organization_id AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_pick_tasks row
               JOIN operations_fulfillment_plans plan
                 ON plan.organization_id = row.organization_id AND plan.id = row.plan_id
               WHERE plan.organization_id = p_organization_id AND plan.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_packages row
               JOIN operations_fulfillment_plans plan
                 ON plan.organization_id = row.organization_id AND plan.id = row.plan_id
               WHERE plan.organization_id = p_organization_id AND plan.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_labels row
               JOIN operations_packages package
                 ON package.organization_id = row.organization_id AND package.id = row.package_id
               JOIN operations_fulfillment_plans plan
                 ON plan.organization_id = package.organization_id AND plan.id = package.plan_id
               WHERE plan.organization_id = p_organization_id AND plan.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_shipments row
               WHERE row.organization_id = p_organization_id AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_commerce_fulfillment_exports row
               WHERE row.organization_id = p_organization_id AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_fulfillment_executions row
               WHERE row.organization_id = p_organization_id AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_active_fulfillment_executions row
               WHERE row.organization_id = p_organization_id AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_label_attempts row
               WHERE row.organization_id = p_organization_id AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_shipment_groups row
               WHERE row.organization_id = p_organization_id AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_billable_events row
               WHERE row.organization_id = p_organization_id AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_sandbox_commerce_e2e_authorizations row
               WHERE row.organization_id = p_organization_id AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_shopify_external_fulfillment_reconciliations row
               WHERE row.organization_id = p_organization_id AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_production_fulfillment_rerate_runs row
               WHERE row.organization_id = p_organization_id AND row.order_id = p_order_id)
  )
$$;

CREATE OR REPLACE FUNCTION validate_ocr_cancellation_exact_read()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action = 'cancel_unstarted_order' AND NOT EXISTS (
    SELECT 1
    FROM operations_commerce_order_revision_targets target
    JOIN operations_orders order_row
      ON order_row.organization_id = target.organization_id
     AND order_row.id = target.order_id
    JOIN operations_commerce_order_revision_reads read_evidence
      ON read_evidence.organization_id = target.organization_id
     AND read_evidence.id = NEW.read_id
     AND read_evidence.target_id = target.id
    JOIN operations_commerce_order_revision_observations observation
      ON observation.organization_id = read_evidence.organization_id
     AND observation.id = read_evidence.observation_id
    WHERE target.organization_id = NEW.organization_id
      AND target.id = NEW.target_id
      AND target.order_id = NEW.order_id
      AND target.integration_account_id = NEW.integration_account_id
      AND target.provider = NEW.provider
      AND order_row.integration_account_id = NEW.integration_account_id
      AND order_row.source_provider = NEW.provider
      AND order_row.status = 'imported'
      AND order_row.row_version = NEW.expected_order_row_version
      AND target.latest_read_id = read_evidence.id
      AND target.latest_observation_id = observation.id
      AND target.material_state = 'provider_cancelled'
      AND read_evidence.observation_id = NEW.observation_id
      AND read_evidence.source_hash = NEW.source_hash
      AND read_evidence.revision_hash = NEW.revision_hash
      AND read_evidence.canonical_row_version = NEW.expected_order_row_version
      AND read_evidence.provider_read_count = NEW.provider_read_count
      AND read_evidence.provider_write_count = 0
      AND read_evidence.created_at >= now() - interval '35 minutes'
      AND observation.source_hash = read_evidence.source_hash
      AND observation.revision_hash = read_evidence.revision_hash
      AND observation.provider_write_count = 0
      AND observation.normalized_snapshot #>>
        '{order,canonicalStates,lifecycle}' = 'cancelled'
      AND observation.normalized_snapshot #>>
        '{order,canonicalStates,fulfillment}' = 'unfulfilled'
      AND observation.normalized_snapshot #>>
        '{order,canonicalStates,returns}' = 'none'
      AND ocr_order_has_zero_downstream(NEW.organization_id, NEW.order_id)
      AND jsonb_typeof(
        observation.normalized_snapshot #> '{order,lines}'
      ) = 'array'
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          observation.normalized_snapshot #> '{order,lines}'
        ) line
        WHERE COALESCE((line->>'fulfilledQuantity')::numeric, 0) <> 0
           OR COALESCE((line->>'returnedQuantity')::numeric, 0) <> 0
      )
  ) THEN
    RAISE EXCEPTION
      'provider cancellation requires a fresh exact unfulfilled read';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ocr_dispositions_exact_read_guard
  ON operations_commerce_order_revision_dispositions;
CREATE TRIGGER ocr_dispositions_exact_read_guard
BEFORE INSERT ON operations_commerce_order_revision_dispositions
FOR EACH ROW EXECUTE FUNCTION validate_ocr_cancellation_exact_read();

CREATE TABLE IF NOT EXISTS operations_commerce_order_revision_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcoa'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  target_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  read_id uuid NOT NULL,
  order_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  action text NOT NULL CHECK (action = 'apply_unstarted_revision'),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  expected_order_row_version bigint NOT NULL CHECK (expected_order_row_version >= 0),
  resulting_order_row_version bigint NOT NULL CHECK (
    resulting_order_row_version = expected_order_row_version + 1
  ),
  previous_status text NOT NULL CHECK (previous_status = 'imported'),
  resulting_status text NOT NULL CHECK (resulting_status = 'imported'),
  previous_source_hash text NOT NULL CHECK (previous_source_hash ~ '^[a-f0-9]{64}$'),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  revision_hash text NOT NULL CHECK (revision_hash ~ '^[a-f0-9]{64}$'),
  change_summary jsonb NOT NULL CHECK (jsonb_typeof(change_summary) = 'object'),
  reason text NOT NULL,
  provider_read_count integer NOT NULL CHECK (provider_read_count BETWEEN 1 AND 4),
  provider_write_count integer NOT NULL CHECK (provider_write_count = 0),
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  lifecycle_state text NOT NULL DEFAULT 'building' CHECK (
    lifecycle_state IN ('building', 'sealed')
  ),
  sealed_at timestamptz,
  applied_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ocr_apps_global_valid CHECK (
    global_id ~ '^gcoa(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT ocr_apps_global_unique UNIQUE (global_id),
  CONSTRAINT ocr_apps_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT ocr_apps_org_order_id_unique
    UNIQUE (organization_id, order_id, id),
  CONSTRAINT ocr_apps_registry_fk
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT ocr_apps_account_fk
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ocr_apps_target_fk
    FOREIGN KEY (organization_id, target_id)
    REFERENCES operations_commerce_order_revision_targets(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ocr_apps_observation_fk
    FOREIGN KEY (organization_id, observation_id)
    REFERENCES operations_commerce_order_revision_observations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ocr_apps_read_fk
    FOREIGN KEY (organization_id, read_id)
    REFERENCES operations_commerce_order_revision_reads(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ocr_apps_order_fk
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ocr_apps_idempotency_unique
    UNIQUE (organization_id, idempotency_key),
  CONSTRAINT ocr_apps_revision_unique
    UNIQUE (organization_id, order_id, source_hash),
  CONSTRAINT ocr_apps_text_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
    AND length(btrim(reason)) BETWEEN 8 AND 500
    AND reason !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ocr_apps_seal_valid CHECK (
    (lifecycle_state = 'building' AND sealed_at IS NULL)
    OR (lifecycle_state = 'sealed' AND sealed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ocr_apps_order_idx
  ON operations_commerce_order_revision_applications (
    organization_id, order_id, applied_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION ocr_order_has_zero_downstream(
  p_organization_id uuid,
  p_order_id uuid
)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT (
    EXISTS (SELECT 1 FROM operations_fulfillment_plans row
            WHERE row.organization_id = p_organization_id
              AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_reservations row
               WHERE row.organization_id = p_organization_id
                 AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_pick_tasks row
               JOIN operations_fulfillment_plans plan
                 ON plan.organization_id = row.organization_id
                AND plan.id = row.plan_id
               WHERE plan.organization_id = p_organization_id
                 AND plan.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_packages row
               JOIN operations_fulfillment_plans plan
                 ON plan.organization_id = row.organization_id
                AND plan.id = row.plan_id
               WHERE plan.organization_id = p_organization_id
                 AND plan.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_labels row
               JOIN operations_packages package
                 ON package.organization_id = row.organization_id
                AND package.id = row.package_id
               JOIN operations_fulfillment_plans plan
                 ON plan.organization_id = package.organization_id
                AND plan.id = package.plan_id
               WHERE plan.organization_id = p_organization_id
                 AND plan.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_shipments row
               WHERE row.organization_id = p_organization_id
                 AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_commerce_fulfillment_exports row
               WHERE row.organization_id = p_organization_id
                 AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_fulfillment_executions row
               WHERE row.organization_id = p_organization_id
                 AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_active_fulfillment_executions row
               WHERE row.organization_id = p_organization_id
                 AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_label_attempts row
               WHERE row.organization_id = p_organization_id
                 AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_shipment_groups row
               WHERE row.organization_id = p_organization_id
                 AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_billable_events row
               WHERE row.organization_id = p_organization_id
                 AND row.order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM operations_sandbox_commerce_e2e_authorizations row
               WHERE row.organization_id = p_organization_id
                 AND row.order_id = p_order_id)
    OR EXISTS (
      SELECT 1
      FROM operations_shopify_external_fulfillment_reconciliations row
      WHERE row.organization_id = p_organization_id
        AND row.order_id = p_order_id
    )
    OR EXISTS (SELECT 1 FROM operations_production_fulfillment_rerate_runs row
               WHERE row.organization_id = p_organization_id
                 AND row.order_id = p_order_id)
  )
$$;

CREATE OR REPLACE FUNCTION ocr_shopify_revision_snapshot_complete(
  p_snapshot jsonb
)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_typeof(p_snapshot) = 'object'
    AND p_snapshot->>'provider' = 'shopify'
    AND jsonb_typeof(p_snapshot->'order') = 'object'
    AND jsonb_typeof(p_snapshot #> '{order,canonicalStates}') = 'object'
    AND p_snapshot #>> '{order,canonicalStates,lifecycle}' = 'open'
    AND p_snapshot #>> '{order,canonicalStates,fulfillment}' = 'unfulfilled'
    AND p_snapshot #>> '{order,canonicalStates,returns}' = 'none'
    AND jsonb_typeof(p_snapshot #> '{order,money}') = 'object'
    AND p_snapshot #>> '{order,money,headerState}' = 'complete'
    AND jsonb_typeof(p_snapshot #> '{order,lines}') = 'array'
    AND jsonb_array_length(p_snapshot #> '{order,lines}') BETWEEN 1 AND 500
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_snapshot #> '{order,lines}') line
      WHERE jsonb_typeof(line) IS DISTINCT FROM 'object'
         OR jsonb_typeof(line->'externalLineId') IS DISTINCT FROM 'string'
         OR COALESCE(line->>'externalLineId', '') = ''
         OR jsonb_typeof(line->'currentQuantity') IS DISTINCT FROM 'number'
         OR line->>'currentQuantity' !~ '^[0-9]+(?:[.][0-9]+)?$'
         OR jsonb_typeof(line->'unfulfilledQuantity') IS DISTINCT FROM 'number'
         OR line->>'unfulfilledQuantity' !~ '^[0-9]+(?:[.][0-9]+)?$'
         OR (line->>'currentQuantity')::numeric < 0
         OR (line->>'unfulfilledQuantity')::numeric < 0
         OR (line->>'currentQuantity')::numeric
              IS DISTINCT FROM (line->>'unfulfilledQuantity')::numeric
         OR jsonb_typeof(line->'fulfilledQuantity') IS DISTINCT FROM 'number'
         OR line->>'fulfilledQuantity' !~ '^[0-9]+(?:[.][0-9]+)?$'
         OR (line->>'fulfilledQuantity')::numeric <> 0
         OR (
           line ? 'returnedQuantity'
           AND line->'returnedQuantity' <> 'null'::jsonb
           AND (
             jsonb_typeof(line->'returnedQuantity') IS DISTINCT FROM 'number'
             OR line->>'returnedQuantity' !~ '^[0-9]+(?:[.][0-9]+)?$'
             OR (line->>'returnedQuantity')::numeric <> 0
           )
         )
    )
  , false)
$$;

CREATE OR REPLACE FUNCTION ocr_faire_revision_snapshot_complete(
  p_snapshot jsonb
)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_typeof(p_snapshot) = 'object'
    AND p_snapshot->>'version' = 'faire-canonical-order-revision-v2'
    AND p_snapshot->>'provider' = 'faire'
    AND jsonb_typeof(p_snapshot->'order') = 'object'
    AND p_snapshot #>> '{order,canonicalStates,lifecycle}' = 'open'
    AND p_snapshot #>> '{order,canonicalStates,fulfillment}' = 'unfulfilled'
    AND p_snapshot #>> '{order,canonicalStates,returns}' = 'none'
    AND p_snapshot #>> '{order,providerRevisionState,orderState}' = 'NEW'
    AND p_snapshot #>> '{order,providerRevisionState,shipmentCount}' = '0'
    AND p_snapshot #>> '{order,providerRevisionState,lineStateBasis}' =
      'all_processing'
    AND p_snapshot #>> '{order,providerRevisionState,quantityBasis}' =
      'exact_order_item_quantity'
    AND p_snapshot #>> '{order,money,headerState}' = 'complete'
    AND jsonb_typeof(p_snapshot #> '{order,lines}') = 'array'
    AND jsonb_array_length(p_snapshot #> '{order,lines}') BETWEEN 1 AND 500
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_snapshot #> '{order,lines}') line
      WHERE jsonb_typeof(line) IS DISTINCT FROM 'object'
         OR COALESCE(line->>'externalLineId', '') = ''
         OR COALESCE(line->>'externalProductId', '') = ''
         OR COALESCE(line->>'externalVariantId', '') = ''
         OR COALESCE(line->>'sku', '') = ''
         OR COALESCE(line->>'orderedQuantity' ~ '^[0-9]+$', false) = false
         OR COALESCE(line->>'currentQuantity' ~ '^[0-9]+$', false) = false
         OR COALESCE(line->>'cancelledQuantity' ~ '^[0-9]+$', false) = false
         OR COALESCE(line->>'fulfilledQuantity' ~ '^[0-9]+$', false) = false
         OR COALESCE(line->>'unfulfilledQuantity' ~ '^[0-9]+$', false) = false
         OR COALESCE(line->>'returnedQuantity' ~ '^[0-9]+$', false) = false
         OR COALESCE(line->>'removedOrRefundedQuantity' ~ '^[0-9]+$', false) = false
         OR (line->>'orderedQuantity')::numeric < 1
         OR (line->>'currentQuantity')::numeric <>
              (line->>'orderedQuantity')::numeric
         OR (line->>'cancelledQuantity')::numeric <> 0
         OR (line->>'fulfilledQuantity')::numeric <> 0
         OR (line->>'unfulfilledQuantity')::numeric <>
              (line->>'currentQuantity')::numeric
         OR (line->>'returnedQuantity')::numeric <> 0
         OR (line->>'removedOrRefundedQuantity')::numeric <> 0
    )
    AND (
      SELECT count(DISTINCT line->>'externalLineId') =
             jsonb_array_length(p_snapshot #> '{order,lines}')
      FROM jsonb_array_elements(p_snapshot #> '{order,lines}') line
    )
  , false)
$$;

CREATE OR REPLACE FUNCTION validate_ocr_application_exact_read()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snapshot jsonb;
  provider_order jsonb;
  provider_line jsonb;
  provider_lines jsonb;
  money jsonb;
  ordered_quantity numeric;
  current_quantity numeric;
  fulfilled_quantity numeric;
  unfulfilled_quantity numeric;
  returned_quantity numeric;
  unit_multiplier numeric;
  unit_price_minor numeric;
  line_subtotal_minor numeric;
  line_total numeric := 0;
  active_line_count integer := 0;
  distinct_line_count integer;
  subtotal_minor numeric;
  shipping_minor numeric;
  tax_minor numeric;
  discount_minor numeric;
  total_minor numeric;
BEGIN
  SELECT observation.normalized_snapshot
    INTO snapshot
    FROM operations_orders order_row
    JOIN operations_commerce_order_revision_targets target
      ON target.organization_id = order_row.organization_id
     AND target.order_id = order_row.id
    JOIN operations_commerce_order_revision_reads read_evidence
      ON read_evidence.organization_id = target.organization_id
     AND read_evidence.id = NEW.read_id
     AND read_evidence.target_id = target.id
    JOIN operations_commerce_order_revision_observations observation
      ON observation.organization_id = read_evidence.organization_id
     AND observation.id = read_evidence.observation_id
    WHERE order_row.organization_id = NEW.organization_id
      AND order_row.id = NEW.order_id
      AND order_row.integration_account_id = NEW.integration_account_id
      AND order_row.source_provider = NEW.provider
      AND order_row.status = 'imported'
      AND order_row.row_version = NEW.expected_order_row_version
      AND NEW.resulting_order_row_version = order_row.row_version + 1
      AND target.id = NEW.target_id
      AND target.integration_account_id = NEW.integration_account_id
      AND target.latest_read_id = read_evidence.id
      AND target.latest_observation_id = observation.id
      AND target.latest_source_hash = NEW.source_hash
      AND target.accepted_source_hash IS DISTINCT FROM NEW.source_hash
      AND target.material_state = 'review_required'
      AND target.claim_state = 'ready'
      AND read_evidence.observation_id = NEW.observation_id
      AND read_evidence.source_hash = NEW.source_hash
      AND read_evidence.revision_hash = NEW.revision_hash
      AND read_evidence.canonical_row_version = NEW.expected_order_row_version
      AND read_evidence.provider_read_count = NEW.provider_read_count
      AND read_evidence.provider_write_count = 0
      AND read_evidence.created_at >= now() - interval '35 minutes'
      AND read_evidence.protected_snapshot_purged_at IS NULL
      AND read_evidence.protected_snapshot_expires_at > now()
      AND read_evidence.party_snapshot_ciphertext IS NOT NULL
      AND read_evidence.party_content_fingerprint =
        observation.normalized_snapshot #>> '{order,partyFingerprint}'
      AND read_evidence.ship_to_snapshot_ciphertext IS NOT NULL
      AND read_evidence.ship_to_content_fingerprint =
        observation.normalized_snapshot #>> '{order,shipToFingerprint}'
      AND observation.source_hash = NEW.source_hash
      AND observation.revision_hash = NEW.revision_hash
      AND observation.provider_write_count = 0
      AND ocr_order_has_zero_downstream(NEW.organization_id, NEW.order_id);

  IF snapshot IS NULL THEN
    RAISE EXCEPTION
      'revision application requires a fresh exact unstarted provider read';
  END IF;

  provider_order := snapshot->'order';
  provider_lines := provider_order->'lines';
  money := provider_order->'money';
  IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object'
     OR snapshot->>'provider' IS DISTINCT FROM NEW.provider
     OR (
       NEW.provider = 'shopify'
       AND snapshot->>'version' IS DISTINCT FROM
         'shopify-canonical-order-revision-v1'
     )
     OR (
       NEW.provider = 'faire'
       AND (
         snapshot->>'version' IS DISTINCT FROM
           'faire-canonical-order-revision-v2'
         OR COALESCE(
              provider_order #>> '{providerRevisionState,orderState}' = 'NEW',
              false
            ) = false
         OR provider_order #>> '{providerRevisionState,shipmentCount}'
              IS DISTINCT FROM '0'
         OR provider_order #>> '{providerRevisionState,lineStateBasis}'
              IS DISTINCT FROM 'all_processing'
         OR provider_order #>> '{providerRevisionState,quantityBasis}'
              IS DISTINCT FROM 'exact_order_item_quantity'
       )
     )
     OR jsonb_typeof(provider_order) IS DISTINCT FROM 'object'
     OR COALESCE(length(btrim(provider_order->>'externalOrderId')) BETWEEN 1 AND 512, false) = false
     OR COALESCE(length(btrim(provider_order->>'orderNumber')) BETWEEN 1 AND 255, false) = false
     OR provider_order->>'sourceHash' IS DISTINCT FROM NEW.source_hash
     OR COALESCE(length(btrim(provider_order->>'sourceRevision')) BETWEEN 1 AND 512, false) = false
     OR jsonb_typeof(provider_order->'rawStates') IS DISTINCT FROM 'object'
     OR jsonb_typeof(provider_order->'canonicalStates') IS DISTINCT FROM 'object'
     OR provider_order #>> '{canonicalStates,lifecycle}' IS DISTINCT FROM 'open'
     OR provider_order #>> '{canonicalStates,fulfillment}' IS DISTINCT FROM 'unfulfilled'
     OR provider_order #>> '{canonicalStates,returns}' IS DISTINCT FROM 'none'
     OR jsonb_typeof(money) IS DISTINCT FROM 'object'
     OR money->>'headerState' IS DISTINCT FROM 'complete'
     OR COALESCE(money->>'reconciliationMode' IN (
       'discount_separate', 'discount_in_subtotal'
     ), false) = false
     OR COALESCE(provider_order->>'currency' ~ '^[A-Z]{3}$', false) = false
     OR COALESCE(provider_order->>'partyFingerprint' ~ '^[a-f0-9]{64}$', false) = false
     OR COALESCE(provider_order->>'shipToFingerprint' ~ '^[a-f0-9]{64}$', false) = false
     OR NOT (provider_order ? 'requestedDeliveryAt')
     OR jsonb_typeof(provider_order->'requestedDeliveryAt') NOT IN (
       'string', 'null'
     )
     OR jsonb_typeof(provider_lines) IS DISTINCT FROM 'array'
     OR jsonb_array_length(provider_lines) NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'revision application provider header is incomplete';
  END IF;

  IF COALESCE(money->>'subtotalMinor' ~ '^[0-9]+$', false) = false
     OR COALESCE(money->>'shippingMinor' ~ '^[0-9]+$', false) = false
     OR COALESCE(money->>'taxMinor' ~ '^[0-9]+$', false) = false
     OR COALESCE(money->>'discountMinor' ~ '^[0-9]+$', false) = false
     OR COALESCE(money->>'totalMinor' ~ '^[0-9]+$', false) = false
  THEN
    RAISE EXCEPTION 'revision application provider money is incomplete';
  END IF;
  subtotal_minor := (money->>'subtotalMinor')::numeric;
  shipping_minor := (money->>'shippingMinor')::numeric;
  tax_minor := (money->>'taxMinor')::numeric;
  discount_minor := (money->>'discountMinor')::numeric;
  total_minor := (money->>'totalMinor')::numeric;
  IF NOT (
    (money->>'reconciliationMode' = 'discount_separate'
      AND total_minor =
        subtotal_minor - discount_minor + shipping_minor + tax_minor)
    OR (money->>'reconciliationMode' = 'discount_in_subtotal'
      AND discount_minor > 0
      AND total_minor = subtotal_minor + shipping_minor + tax_minor)
  ) THEN
    RAISE EXCEPTION 'revision application provider money does not reconcile';
  END IF;

  FOR provider_line IN SELECT value FROM jsonb_array_elements(provider_lines)
  LOOP
    IF jsonb_typeof(provider_line) IS DISTINCT FROM 'object'
       OR COALESCE(length(btrim(provider_line->>'externalLineId')) BETWEEN 1 AND 512, false) = false
       OR COALESCE(length(btrim(provider_line->>'externalProductId')) BETWEEN 1 AND 512, false) = false
       OR COALESCE(length(btrim(provider_line->>'externalVariantId')) BETWEEN 1 AND 512, false) = false
       OR COALESCE(length(btrim(provider_line->>'sku')) BETWEEN 1 AND 255, false) = false
       OR COALESCE(length(btrim(provider_line->>'titleSnapshot')) BETWEEN 1 AND 500, false) = false
       OR COALESCE(provider_line->>'sourceHash' ~ '^[a-f0-9]{64}$', false) = false
       OR COALESCE(provider_line->>'orderedQuantity' ~ '^[0-9]+$', false) = false
       OR COALESCE(provider_line->>'currentQuantity' ~ '^[0-9]+$', false) = false
       OR COALESCE(provider_line->>'cancelledQuantity' ~ '^[0-9]+$', false) = false
       OR COALESCE(provider_line->>'fulfilledQuantity' ~ '^[0-9]+$', false) = false
       OR COALESCE(provider_line->>'unfulfilledQuantity' ~ '^[0-9]+$', false) = false
       OR NOT (provider_line ? 'returnedQuantity')
       OR (
         NEW.provider = 'shopify'
         AND provider_line->'returnedQuantity' IS DISTINCT FROM 'null'::jsonb
       )
       OR (
         NEW.provider = 'faire'
         AND COALESCE(
           provider_line->>'returnedQuantity' ~ '^[0-9]+$', false
         ) = false
       )
       OR COALESCE(provider_line->>'removedOrRefundedQuantity' ~ '^[0-9]+$', false) = false
       OR COALESCE(provider_line->>'physicalUnitQuantity' ~ '^[0-9]+$', false) = false
       OR COALESCE(provider_line->>'unitPriceMinor' ~ '^[0-9]+$', false) = false
       OR COALESCE(provider_line->>'lineSubtotalMinor' ~ '^[0-9]+$', false) = false
       OR jsonb_typeof(provider_line->'requiresShipping') IS DISTINCT FROM 'boolean'
       OR NOT (provider_line ? 'unitMultiplier')
       OR (
         NEW.provider = 'shopify'
         AND provider_line->'unitMultiplier' IS DISTINCT FROM 'null'::jsonb
       )
       OR (
         NEW.provider = 'faire'
         AND provider_line->'unitMultiplier' <> 'null'::jsonb
         AND COALESCE(
           provider_line->>'unitMultiplier' ~ '^[0-9]+$', false
         ) = false
       )
    THEN
      RAISE EXCEPTION 'revision application provider line is incomplete';
    END IF;
    ordered_quantity := (provider_line->>'orderedQuantity')::numeric;
    current_quantity := (provider_line->>'currentQuantity')::numeric;
    fulfilled_quantity := (provider_line->>'fulfilledQuantity')::numeric;
    unfulfilled_quantity := (provider_line->>'unfulfilledQuantity')::numeric;
    returned_quantity := COALESCE(
      (provider_line->>'returnedQuantity')::numeric,
      0
    );
    unit_multiplier := COALESCE(
      (provider_line->>'unitMultiplier')::numeric,
      1
    );
    unit_price_minor := (provider_line->>'unitPriceMinor')::numeric;
    line_subtotal_minor := (provider_line->>'lineSubtotalMinor')::numeric;
    IF ordered_quantity < 1
       OR current_quantity < 0 OR current_quantity > ordered_quantity
       OR (
         NEW.provider = 'shopify'
         AND (provider_line->>'cancelledQuantity')::numeric <>
              ordered_quantity - current_quantity
       )
       OR (
         NEW.provider = 'faire'
         AND (
           current_quantity <> ordered_quantity
           OR (provider_line->>'cancelledQuantity')::numeric <> 0
           OR (provider_line->>'removedOrRefundedQuantity')::numeric <> 0
         )
       )
       OR fulfilled_quantity <> 0 OR returned_quantity <> 0
       OR unfulfilled_quantity <> current_quantity
       OR (
         NEW.provider = 'shopify'
         AND (provider_line->>'removedOrRefundedQuantity')::numeric <>
              ordered_quantity - current_quantity
       )
       OR (provider_line->>'physicalUnitQuantity')::numeric <>
            ordered_quantity * unit_multiplier
       OR unit_multiplier < 1
       OR line_subtotal_minor <> current_quantity * unit_price_minor
    THEN
      RAISE EXCEPTION 'revision application provider line does not reconcile';
    END IF;
    IF current_quantity > 0 THEN
      active_line_count := active_line_count + 1;
      line_total := line_total + line_subtotal_minor;
    END IF;
  END LOOP;
  SELECT count(DISTINCT line->>'externalLineId')
    INTO distinct_line_count
  FROM jsonb_array_elements(provider_lines) line;
  IF active_line_count < 1
     OR distinct_line_count <> jsonb_array_length(provider_lines)
     OR NOT (
       (money->>'reconciliationMode' = 'discount_separate'
         AND line_total = subtotal_minor)
       OR (money->>'reconciliationMode' = 'discount_in_subtotal'
         AND line_total - discount_minor = subtotal_minor)
     )
  THEN
    RAISE EXCEPTION 'revision application provider line set is ambiguous';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ocr_apps_exact_read_guard
  ON operations_commerce_order_revision_applications;
CREATE TRIGGER ocr_apps_exact_read_guard
BEFORE INSERT ON operations_commerce_order_revision_applications
FOR EACH ROW EXECUTE FUNCTION validate_ocr_application_exact_read();

CREATE TABLE IF NOT EXISTS operations_commerce_order_revision_application_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcal'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  application_id uuid NOT NULL,
  order_id uuid NOT NULL,
  canonical_order_line_id uuid NOT NULL,
  candidate_line_id uuid,
  prior_application_line_id uuid,
  planning_line_id uuid NOT NULL,
  planning_global_id text NOT NULL,
  line_sequence integer NOT NULL CHECK (line_sequence > 0),
  external_line_id text NOT NULL,
  external_product_id text NOT NULL,
  external_variant_id text NOT NULL,
  sku text NOT NULL,
  title_snapshot text NOT NULL,
  variant_title_snapshot text,
  active boolean NOT NULL,
  canonical_quantity numeric(20,6) CHECK (canonical_quantity > 0),
  unit_multiplier numeric(20,6) NOT NULL CHECK (unit_multiplier > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  requires_shipping boolean NOT NULL,
  product_id uuid NOT NULL,
  product_mapping_id uuid NOT NULL,
  variant_pack_mapping_id uuid,
  variant_pack_mapping_row_version bigint,
  pack_profile_version_id uuid,
  pack_profile_version_row_version bigint,
  pack_profile_package_level text,
  pack_profile_base_each_quantity integer,
  packaging_weight_source text,
  weight_grams integer NOT NULL CHECK (weight_grams >= 0),
  length_mm integer NOT NULL CHECK (length_mm > 0),
  width_mm integer NOT NULL CHECK (width_mm > 0),
  height_mm integer NOT NULL CHECK (height_mm > 0),
  line_source_hash text NOT NULL CHECK (line_source_hash ~ '^[a-f0-9]{64}$'),
  change_kind text NOT NULL CHECK (
    change_kind IN ('retained', 'changed', 'added', 'removed')
  ),
  prior_canonical_snapshot jsonb CHECK (
    prior_canonical_snapshot IS NULL
    OR jsonb_typeof(prior_canonical_snapshot) = 'object'
  ),
  prior_canonical_fingerprint text CHECK (
    prior_canonical_fingerprint IS NULL
    OR prior_canonical_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ocr_app_lines_global_valid CHECK (
    global_id ~ '^gcal(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT ocr_app_lines_global_unique
    UNIQUE (global_id),
  CONSTRAINT ocr_app_lines_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT ocr_app_lines_org_order_id_unique
    UNIQUE (organization_id, order_id, id),
  CONSTRAINT ocr_app_lines_registry_fk
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT ocr_app_lines_application_fk
    FOREIGN KEY (organization_id, order_id, application_id)
    REFERENCES operations_commerce_order_revision_applications(
      organization_id, order_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT ocr_app_lines_canonical_fk
    FOREIGN KEY (organization_id, order_id, canonical_order_line_id)
    REFERENCES operations_order_lines(organization_id, order_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ocr_app_lines_candidate_fk
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id, candidate_line_id
    ) REFERENCES operations_commerce_order_candidate_lines(
      organization_id, integration_account_id, pipeline_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT ocr_app_lines_prior_fk
    FOREIGN KEY (organization_id, order_id, prior_application_line_id)
    REFERENCES operations_commerce_order_revision_application_lines(
      organization_id, order_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT ocr_app_lines_mapping_fk
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id,
      product_mapping_id, product_id
    ) REFERENCES operations_product_mappings(
      organization_id, integration_account_id, pipeline_id, id, product_id
    ) ON DELETE RESTRICT,
  CONSTRAINT ocr_app_lines_pack_mapping_fk
    FOREIGN KEY (organization_id, variant_pack_mapping_id)
    REFERENCES operations_commerce_variant_pack_mappings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ocr_app_lines_pack_version_fk
    FOREIGN KEY (organization_id, pack_profile_version_id)
    REFERENCES operations_product_pack_profile_versions(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ocr_app_lines_external_unique
    UNIQUE (application_id, external_line_id),
  CONSTRAINT ocr_app_lines_canonical_unique
    UNIQUE (application_id, canonical_order_line_id),
  CONSTRAINT ocr_app_lines_candidate_unique
    UNIQUE (application_id, candidate_line_id),
  CONSTRAINT ocr_app_lines_prior_unique
    UNIQUE (application_id, prior_application_line_id),
  CONSTRAINT ocr_app_lines_text_valid CHECK (
    length(btrim(external_line_id)) BETWEEN 1 AND 512
    AND external_line_id !~ '[[:cntrl:]]'
    AND length(btrim(external_product_id)) BETWEEN 1 AND 512
    AND external_product_id !~ '[[:cntrl:]]'
    AND length(btrim(external_variant_id)) BETWEEN 1 AND 512
    AND external_variant_id !~ '[[:cntrl:]]'
    AND length(btrim(sku)) BETWEEN 1 AND 255
    AND sku !~ '[[:cntrl:]]'
    AND length(btrim(title_snapshot)) BETWEEN 1 AND 500
    AND title_snapshot !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ocr_app_lines_pack_valid CHECK (
    (
      requires_shipping = false
      AND variant_pack_mapping_id IS NULL
      AND variant_pack_mapping_row_version IS NULL
      AND pack_profile_version_id IS NULL
      AND pack_profile_version_row_version IS NULL
      AND pack_profile_package_level IS NULL
      AND pack_profile_base_each_quantity IS NULL
      AND packaging_weight_source IS NULL
      AND weight_grams = 0
      AND length_mm = 1 AND width_mm = 1 AND height_mm = 1
    ) OR (
      requires_shipping = true
      AND variant_pack_mapping_id IS NOT NULL
      AND variant_pack_mapping_row_version IS NOT NULL
      AND pack_profile_version_id IS NOT NULL
      AND pack_profile_version_row_version IS NOT NULL
      AND pack_profile_package_level IS NOT NULL
      AND pack_profile_base_each_quantity IS NOT NULL
      AND pack_profile_base_each_quantity > 0
      AND packaging_weight_source IS NOT NULL
      AND weight_grams > 0
    )
  ),
  CONSTRAINT ocr_app_lines_active_valid CHECK (
    (active = true AND canonical_quantity IS NOT NULL AND change_kind <> 'removed')
    OR (active = false AND canonical_quantity IS NULL AND change_kind = 'removed')
  ),
  CONSTRAINT ocr_app_lines_prior_valid CHECK (
    (change_kind = 'added' AND candidate_line_id IS NULL
      AND prior_application_line_id IS NULL
      AND prior_canonical_snapshot IS NULL
      AND prior_canonical_fingerprint IS NULL)
    OR (change_kind <> 'added'
      AND (candidate_line_id IS NOT NULL) <>
          (prior_application_line_id IS NOT NULL)
      AND prior_canonical_snapshot IS NOT NULL
      AND prior_canonical_fingerprint IS NOT NULL)
  ),
  CONSTRAINT ocr_app_lines_planning_global_valid CHECK (
    planning_global_id ~ '^(?:gcol|gcal)(?:[0-9]{7}|[0-9a-v]{12})$'
  )
);

CREATE OR REPLACE FUNCTION validate_ocr_application_line_planning_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  candidate_record record;
  prior_record record;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_commerce_order_revision_applications application
    WHERE application.organization_id = NEW.organization_id
      AND application.id = NEW.application_id
      AND application.order_id = NEW.order_id
      AND application.integration_account_id = NEW.integration_account_id
      AND application.lifecycle_state = 'building'
  ) THEN
    RAISE EXCEPTION 'revision application lines require a building application';
  END IF;
  IF NEW.candidate_line_id IS NOT NULL THEN
    SELECT candidate.id, candidate.global_id,
           candidate.canonical_order_line_id,
           candidate.external_line_id
      INTO candidate_record
    FROM operations_commerce_order_candidate_lines candidate
    JOIN operations_commerce_order_candidates order_candidate
      ON order_candidate.organization_id = candidate.organization_id
     AND order_candidate.id = candidate.order_candidate_id
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.id = NEW.candidate_line_id
      AND candidate.integration_account_id = NEW.integration_account_id
      AND candidate.pipeline_id = NEW.pipeline_id
      AND order_candidate.canonical_order_id = NEW.order_id;
    IF candidate_record.id IS NULL
       OR candidate_record.canonical_order_line_id IS DISTINCT FROM
          NEW.canonical_order_line_id
       OR candidate_record.external_line_id IS DISTINCT FROM NEW.external_line_id
    THEN
      RAISE EXCEPTION 'revision line candidate planning identity is invalid';
    END IF;
    NEW.planning_line_id := candidate_record.id;
    NEW.planning_global_id := candidate_record.global_id;
  ELSIF NEW.prior_application_line_id IS NOT NULL THEN
    SELECT prior.planning_line_id, prior.planning_global_id,
           prior.canonical_order_line_id, prior.external_line_id
      INTO prior_record
    FROM operations_commerce_order_revision_application_lines prior
    JOIN operations_commerce_order_revision_applications prior_application
      ON prior_application.organization_id = prior.organization_id
     AND prior_application.id = prior.application_id
    WHERE prior.organization_id = NEW.organization_id
      AND prior.order_id = NEW.order_id
      AND prior.id = NEW.prior_application_line_id
      AND prior_application.lifecycle_state = 'sealed';
    IF prior_record.planning_line_id IS NULL
       OR prior_record.canonical_order_line_id IS DISTINCT FROM
          NEW.canonical_order_line_id
       OR prior_record.external_line_id IS DISTINCT FROM NEW.external_line_id
    THEN
      RAISE EXCEPTION 'revision-native prior planning identity is invalid';
    END IF;
    NEW.planning_line_id := prior_record.planning_line_id;
    NEW.planning_global_id := prior_record.planning_global_id;
  ELSIF NEW.change_kind = 'added' THEN
    NEW.planning_line_id := NEW.id;
    NEW.planning_global_id := NEW.global_id;
  ELSE
    RAISE EXCEPTION 'revision line planning identity is missing';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ocr_app_lines_planning_identity
  ON operations_commerce_order_revision_application_lines;
CREATE TRIGGER ocr_app_lines_planning_identity
BEFORE INSERT ON operations_commerce_order_revision_application_lines
FOR EACH ROW EXECUTE FUNCTION validate_ocr_application_line_planning_identity();

CREATE INDEX IF NOT EXISTS ocr_app_lines_order_idx
  ON operations_commerce_order_revision_application_lines (
    organization_id, order_id, application_id, line_sequence
  );

ALTER TABLE operations_commerce_order_revision_targets
  ADD COLUMN IF NOT EXISTS applied_application_id uuid;

ALTER TABLE operations_commerce_order_revision_targets
  DROP CONSTRAINT IF EXISTS ocr_targets_applied_application_fk;
ALTER TABLE operations_commerce_order_revision_targets
  ADD CONSTRAINT ocr_targets_applied_application_fk
  FOREIGN KEY (organization_id, order_id, applied_application_id)
  REFERENCES operations_commerce_order_revision_applications(organization_id, order_id, id)
  ON DELETE RESTRICT;

ALTER TABLE operations_commerce_order_candidates
  ADD COLUMN IF NOT EXISTS accepted_revision_application_id uuid;

ALTER TABLE operations_commerce_order_candidates
  DROP CONSTRAINT IF EXISTS ocr_candidates_revision_application_fk;
ALTER TABLE operations_commerce_order_candidates
  ADD CONSTRAINT ocr_candidates_revision_application_fk
  FOREIGN KEY (
    organization_id, canonical_order_id, accepted_revision_application_id
  ) REFERENCES operations_commerce_order_revision_applications(
    organization_id, order_id, id
  ) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION validate_ocr_accepted_application_pointer()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_result_version bigint;
  new_result_version bigint;
BEGIN
  IF OLD.accepted_revision_application_id IS NOT NULL
     AND NEW.accepted_revision_application_id IS NULL
  THEN
    RAISE EXCEPTION 'accepted revision application pointer cannot be cleared';
  END IF;
  IF NEW.accepted_revision_application_id IS DISTINCT FROM
       OLD.accepted_revision_application_id
  THEN
    SELECT application.resulting_order_row_version
      INTO new_result_version
    FROM operations_commerce_order_revision_applications application
    WHERE application.organization_id = NEW.organization_id
      AND application.order_id = NEW.canonical_order_id
      AND application.id = NEW.accepted_revision_application_id
      AND application.lifecycle_state = 'sealed';
    IF new_result_version IS NULL THEN
      RAISE EXCEPTION 'accepted revision application must be sealed';
    END IF;
    IF OLD.accepted_revision_application_id IS NOT NULL THEN
      SELECT application.resulting_order_row_version
        INTO old_result_version
      FROM operations_commerce_order_revision_applications application
      WHERE application.organization_id = OLD.organization_id
        AND application.order_id = OLD.canonical_order_id
        AND application.id = OLD.accepted_revision_application_id;
      IF old_result_version IS NULL OR new_result_version <= old_result_version THEN
        RAISE EXCEPTION 'accepted revision application pointer must advance';
      END IF;
    END IF;
  ELSIF NEW.accepted_revision_application_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM operations_commerce_order_revision_applications application
    WHERE application.organization_id = NEW.organization_id
      AND application.order_id = NEW.canonical_order_id
      AND application.id = NEW.accepted_revision_application_id
      AND application.lifecycle_state = 'sealed'
  ) THEN
    RAISE EXCEPTION 'accepted revision application must be sealed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ocr_candidate_application_sealed_guard
  ON operations_commerce_order_candidates;
CREATE TRIGGER ocr_candidate_application_sealed_guard
BEFORE UPDATE OF accepted_revision_application_id
ON operations_commerce_order_candidates
FOR EACH ROW EXECUTE FUNCTION validate_ocr_accepted_application_pointer();

CREATE OR REPLACE FUNCTION validate_ocr_target_application_pointer()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_result_version bigint;
  new_result_version bigint;
BEGIN
  IF OLD.applied_application_id IS NOT NULL
     AND NEW.applied_application_id IS NULL
  THEN
    RAISE EXCEPTION 'target revision application pointer cannot be cleared';
  END IF;
  IF NEW.applied_application_id IS DISTINCT FROM OLD.applied_application_id THEN
    SELECT application.resulting_order_row_version
      INTO new_result_version
    FROM operations_commerce_order_revision_applications application
    WHERE application.organization_id = NEW.organization_id
      AND application.order_id = NEW.order_id
      AND application.id = NEW.applied_application_id
      AND application.lifecycle_state = 'sealed'
      AND application.observation_id = NEW.accepted_observation_id
      AND application.read_id = NEW.accepted_read_id
      AND application.source_hash = NEW.accepted_source_hash
      AND application.revision_hash = NEW.accepted_revision_hash;
    IF new_result_version IS NULL THEN
      RAISE EXCEPTION 'target revision application pointer must be sealed and exact';
    END IF;
    IF OLD.applied_application_id IS NOT NULL THEN
      SELECT application.resulting_order_row_version
        INTO old_result_version
      FROM operations_commerce_order_revision_applications application
      WHERE application.organization_id = OLD.organization_id
        AND application.order_id = OLD.order_id
        AND application.id = OLD.applied_application_id;
      IF old_result_version IS NULL OR new_result_version <= old_result_version THEN
        RAISE EXCEPTION 'target revision application pointer must advance';
      END IF;
    END IF;
  END IF;
  IF NOT (
    (
      NEW.accepted_source_hash IS NOT NULL
      AND NEW.accepted_observation_id IS NULL
      AND NEW.accepted_read_id IS NULL
      AND NEW.accepted_revision_hash IS NULL
      AND NEW.applied_application_id IS NULL
    )
    OR (
      NEW.accepted_source_hash IS NOT NULL
      AND NEW.accepted_observation_id IS NOT NULL
      AND NEW.accepted_read_id IS NOT NULL
      AND NEW.accepted_revision_hash IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'target accepted revision evidence must be complete';
  END IF;
  IF NEW.accepted_read_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM operations_commerce_order_revision_reads read_evidence
    JOIN operations_commerce_order_revision_observations observation
      ON observation.organization_id = read_evidence.organization_id
     AND observation.id = read_evidence.observation_id
    WHERE read_evidence.organization_id = NEW.organization_id
      AND read_evidence.id = NEW.accepted_read_id
      AND read_evidence.target_id = NEW.id
      AND read_evidence.order_id = NEW.order_id
      AND read_evidence.integration_account_id = NEW.integration_account_id
      AND read_evidence.provider = NEW.provider
      AND read_evidence.observation_id = NEW.accepted_observation_id
      AND read_evidence.source_hash = NEW.accepted_source_hash
      AND read_evidence.revision_hash = NEW.accepted_revision_hash
      AND read_evidence.provider_write_count = 0
      AND observation.order_id = NEW.order_id
      AND observation.integration_account_id = NEW.integration_account_id
      AND observation.provider = NEW.provider
      AND observation.source_hash = read_evidence.source_hash
      AND observation.revision_hash = read_evidence.revision_hash
      AND observation.provider_write_count = 0
  ) THEN
    RAISE EXCEPTION 'target accepted revision evidence must match its exact read';
  END IF;
  IF NEW.accepted_read_id IS DISTINCT FROM OLD.accepted_read_id THEN
    IF NEW.accepted_read_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM operations_commerce_order_revision_reads read_evidence
      JOIN operations_commerce_order_revision_observations observation
        ON observation.organization_id = read_evidence.organization_id
       AND observation.id = read_evidence.observation_id
      LEFT JOIN operations_commerce_order_revision_reads old_read
        ON old_read.organization_id = NEW.organization_id
       AND old_read.id = OLD.accepted_read_id
      WHERE read_evidence.organization_id = NEW.organization_id
        AND read_evidence.id = NEW.accepted_read_id
        AND read_evidence.target_id = NEW.id
        AND read_evidence.order_id = NEW.order_id
        AND read_evidence.integration_account_id = NEW.integration_account_id
        AND read_evidence.provider = NEW.provider
        AND read_evidence.id = NEW.latest_read_id
        AND read_evidence.observation_id = NEW.accepted_observation_id
        AND read_evidence.source_hash = NEW.accepted_source_hash
        AND read_evidence.revision_hash = NEW.accepted_revision_hash
        AND read_evidence.provider_write_count = 0
        AND observation.order_id = NEW.order_id
        AND observation.integration_account_id = NEW.integration_account_id
        AND observation.provider = NEW.provider
        AND observation.source_hash = read_evidence.source_hash
        AND observation.revision_hash = read_evidence.revision_hash
        AND observation.provider_write_count = 0
        AND (
          old_read.id IS NULL
          OR (read_evidence.created_at, read_evidence.id)
               > (old_read.created_at, old_read.id)
        )
    ) THEN
      RAISE EXCEPTION 'target accepted revision read must advance exactly';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ocr_target_application_sealed_guard
  ON operations_commerce_order_revision_targets;
CREATE TRIGGER ocr_target_application_sealed_guard
BEFORE UPDATE OF applied_application_id, accepted_observation_id,
  accepted_read_id, accepted_source_hash, accepted_revision_hash
ON operations_commerce_order_revision_targets
FOR EACH ROW EXECUTE FUNCTION validate_ocr_target_application_pointer();

CREATE OR REPLACE FUNCTION ensure_ocr_application_pointers_consistent()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scoped_organization_id uuid;
  scoped_order_id uuid;
BEGIN
  scoped_organization_id := NEW.organization_id;
  IF TG_TABLE_NAME = 'operations_commerce_order_candidates' THEN
    scoped_order_id := NEW.canonical_order_id;
  ELSE
    scoped_order_id := NEW.order_id;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM operations_commerce_order_candidates candidate
    JOIN operations_commerce_order_revision_targets target
      ON target.organization_id = candidate.organization_id
     AND target.order_id = candidate.canonical_order_id
    WHERE candidate.organization_id = scoped_organization_id
      AND candidate.canonical_order_id = scoped_order_id
      AND candidate.workflow_state = 'promoted'
      AND candidate.accepted_revision_application_id IS DISTINCT FROM
          target.applied_application_id
  ) THEN
    RAISE EXCEPTION 'accepted revision application pointers are split';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ocr_candidate_application_pointer_consistency
  ON operations_commerce_order_candidates;
CREATE CONSTRAINT TRIGGER ocr_candidate_application_pointer_consistency
AFTER UPDATE OF accepted_revision_application_id
ON operations_commerce_order_candidates
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_ocr_application_pointers_consistent();

DROP TRIGGER IF EXISTS ocr_target_application_pointer_consistency
  ON operations_commerce_order_revision_targets;
CREATE CONSTRAINT TRIGGER ocr_target_application_pointer_consistency
AFTER UPDATE OF applied_application_id
ON operations_commerce_order_revision_targets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_ocr_application_pointers_consistent();

ALTER TABLE operations_order_lines
  ADD COLUMN IF NOT EXISTS revision_retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS revision_application_id uuid;

ALTER TABLE operations_order_lines
  DROP CONSTRAINT IF EXISTS ocr_order_lines_retirement_valid,
  DROP CONSTRAINT IF EXISTS ocr_order_lines_application_fk;
ALTER TABLE operations_order_lines
  ADD CONSTRAINT ocr_order_lines_retirement_valid CHECK (
    (revision_retired_at IS NULL AND revision_application_id IS NULL)
    OR (revision_retired_at IS NOT NULL AND revision_application_id IS NOT NULL)
  ),
  ADD CONSTRAINT ocr_order_lines_application_fk
    FOREIGN KEY (organization_id, order_id, revision_application_id)
    REFERENCES operations_commerce_order_revision_applications(
      organization_id, order_id, id
    ) ON DELETE RESTRICT;

CREATE OR REPLACE VIEW operations_current_order_lines AS
SELECT line.*
FROM operations_order_lines line
WHERE line.revision_retired_at IS NULL;

CREATE OR REPLACE VIEW operations_commerce_current_planning_lines AS
SELECT
  line.id,
  line.global_id,
  line.organization_id,
  line.integration_account_id,
  line.pipeline_id,
  line.run_id,
  line.order_candidate_id,
  line.provider,
  line.external_line_id,
  line.external_product_id,
  line.external_variant_id,
  line.sku_snapshot,
  line.product_title_snapshot,
  line.variant_title_snapshot,
  line.provider_status_raw,
  line.normalized_status,
  line.ordered_quantity,
  line.current_quantity,
  line.cancelled_quantity,
  line.fulfilled_quantity,
  line.unfulfilled_quantity,
  line.returned_quantity,
  line.unit_multiplier,
  line.physical_quantity,
  line.currency_code,
  line.unit_price_minor,
  line.price_resolution_state,
  line.resolved_currency_code,
  line.resolved_unit_price_minor,
  line.mapping_state,
  line.product_id,
  line.product_mapping_id,
  line.packaging_state,
  line.commerce_variant_pack_mapping_id,
  line.commerce_variant_pack_mapping_row_version,
  line.pack_profile_version_id,
  line.pack_profile_version_row_version,
  line.pack_profile_package_level,
  line.pack_profile_base_each_quantity,
  line.packaging_source,
  line.packaging_weight_source,
  line.weight_grams,
  line.length_mm,
  line.width_mm,
  line.height_mm,
  line.requires_shipping,
  line.workflow_state,
  line.blocking_codes,
  line.source_revision,
  line.source_hash,
  line.observed_at,
  line.canonical_order_line_id,
  line.row_version,
  line.created_at
FROM operations_commerce_order_candidate_lines line
JOIN operations_commerce_order_candidates candidate
  ON candidate.organization_id = line.organization_id
 AND candidate.id = line.order_candidate_id
WHERE candidate.accepted_revision_application_id IS NULL
UNION ALL
SELECT
  revision_line.planning_line_id AS id,
  revision_line.planning_global_id AS global_id,
  revision_line.organization_id,
  revision_line.integration_account_id,
  revision_line.pipeline_id,
  candidate.run_id,
  candidate.id AS order_candidate_id,
  application.provider,
  revision_line.external_line_id,
  revision_line.external_product_id,
  revision_line.external_variant_id,
  revision_line.sku AS sku_snapshot,
  revision_line.title_snapshot AS product_title_snapshot,
  revision_line.variant_title_snapshot,
  'UNFULFILLED'::text AS provider_status_raw,
  'open'::text AS normalized_status,
  revision_line.canonical_quantity AS ordered_quantity,
  revision_line.canonical_quantity AS current_quantity,
  0::numeric AS cancelled_quantity,
  0::numeric AS fulfilled_quantity,
  revision_line.canonical_quantity AS unfulfilled_quantity,
  0::numeric AS returned_quantity,
  revision_line.unit_multiplier,
  revision_line.canonical_quantity * revision_line.unit_multiplier
    AS physical_quantity,
  order_row.currency AS currency_code,
  revision_line.unit_price_minor,
  'provider'::text AS price_resolution_state,
  order_row.currency AS resolved_currency_code,
  revision_line.unit_price_minor AS resolved_unit_price_minor,
  'resolved'::text AS mapping_state,
  revision_line.product_id,
  revision_line.product_mapping_id,
  CASE WHEN revision_line.requires_shipping
    THEN 'resolved' ELSE 'not_required' END AS packaging_state,
  revision_line.variant_pack_mapping_id
    AS commerce_variant_pack_mapping_id,
  revision_line.variant_pack_mapping_row_version
    AS commerce_variant_pack_mapping_row_version,
  revision_line.pack_profile_version_id,
  revision_line.pack_profile_version_row_version,
  revision_line.pack_profile_package_level,
  revision_line.pack_profile_base_each_quantity,
  CASE WHEN revision_line.requires_shipping
    THEN 'variant_pack_mapping' ELSE 'none' END AS packaging_source,
  revision_line.packaging_weight_source,
  revision_line.weight_grams,
  revision_line.length_mm,
  revision_line.width_mm,
  revision_line.height_mm,
  revision_line.requires_shipping,
  'promoted'::text AS workflow_state,
  '{}'::text[] AS blocking_codes,
  observation.source_revision,
  revision_line.line_source_hash AS source_hash,
  read_evidence.observed_at,
  revision_line.canonical_order_line_id,
  0::bigint AS row_version,
  revision_line.created_at
FROM operations_commerce_order_revision_application_lines revision_line
JOIN operations_commerce_order_revision_applications application
  ON application.organization_id = revision_line.organization_id
 AND application.id = revision_line.application_id
 AND application.lifecycle_state = 'sealed'
JOIN operations_commerce_order_revision_observations observation
  ON observation.organization_id = application.organization_id
 AND observation.id = application.observation_id
JOIN operations_commerce_order_revision_reads read_evidence
  ON read_evidence.organization_id = application.organization_id
 AND read_evidence.id = application.read_id
JOIN operations_commerce_order_candidates candidate
  ON candidate.organization_id = revision_line.organization_id
 AND candidate.canonical_order_id = revision_line.order_id
 AND candidate.accepted_revision_application_id = revision_line.application_id
LEFT JOIN operations_commerce_order_candidate_lines candidate_line
  ON candidate_line.organization_id = revision_line.organization_id
 AND candidate_line.integration_account_id = revision_line.integration_account_id
 AND candidate_line.pipeline_id = revision_line.pipeline_id
 AND candidate_line.id = revision_line.candidate_line_id
 AND candidate_line.order_candidate_id = candidate.id
JOIN operations_orders order_row
  ON order_row.organization_id = revision_line.organization_id
 AND order_row.id = revision_line.order_id
WHERE revision_line.active = true;

-- Accepted revision-native planning rows use gcal identities. Widen the two
-- retained cartonization evidence validators without weakening any other
-- allocation field or product identity contract.
CREATE OR REPLACE FUNCTION operations_cartonization_allocations_valid(
  value jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(value) IS DISTINCT FROM 'array' THEN false
    WHEN jsonb_array_length(value) NOT BETWEEN 1 AND 500 THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value) AS allocation(item)
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
        OR (
          SELECT array_agg(key ORDER BY key)
          FROM jsonb_object_keys(item) AS field(key)
        ) IS DISTINCT FROM ARRAY[
          'lineGlobalId', 'productGlobalId', 'quantity', 'title'
        ]::text[]
        OR COALESCE(
          item->>'lineGlobalId'
            !~ '^(?:gcol|gcal)(?:[0-9]{7}|[0-9a-v]{12})$',
          true
        )
        OR COALESCE(
          item->>'productGlobalId' !~ '^gp(?:[0-9]{7}|[0-9a-v]{12})$',
          true
        )
        OR jsonb_typeof(item->'title') IS DISTINCT FROM 'string'
        OR length(btrim(item->>'title')) NOT BETWEEN 1 AND 512
        OR item->>'title' ~ '[[:cntrl:]]'
        OR jsonb_typeof(item->'quantity') IS DISTINCT FROM 'number'
        OR COALESCE(item->>'quantity' !~ '^[1-9][0-9]{0,8}$', true)
    )
  END
$$;

ALTER TABLE operations_cartonization_rate_evidence_package_profiles
  DROP CONSTRAINT IF EXISTS
    operations_cartonization_rate_evidence_package_profiles_line_global_id_check;
ALTER TABLE operations_cartonization_rate_evidence_package_profiles
  ADD CONSTRAINT ops_cart_profile_line_global_valid CHECK (
    line_global_id ~ '^(?:gcol|gcal)(?:[0-9]{7}|[0-9a-v]{12})$'
  );

-- Existing trigger functions were compiled against the base canonical line
-- table before revision retirement existed. Recompile every live execution or
-- demand authority that reads that table so a retired line cannot re-enter by
-- bypassing the application-level current-line view.
DO $ocr_current_line_functions$
DECLARE
  authority record;
  revised_definition text;
BEGIN
  FOR authority IN
    SELECT procedure.oid, pg_get_functiondef(procedure.oid) AS definition
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = current_schema()
      AND procedure.proname IN (
        'validate_ops_fulfillment_allocation_integrity',
        'validate_ops_reservation_authority',
        'validate_operations_fulfillment_execution',
        'operations_provider_commitment_current_support',
        'validate_ops_plan_cartonization_evidence',
        'validate_ops_activation_canonical_plans',
        'operations_one_off_plan_package_set_is_exact',
        'operations_one_off_package_snapshot_hash',
        'validate_operations_cartonization_rate_profile_evidence_complete',
        'operations_sandbox_commerce_e2e_authorization_is_current'
      )
  LOOP
    revised_definition := replace(
      authority.definition,
      'operations_order_lines',
      'operations_current_order_lines'
    );
    revised_definition := replace(
      revised_definition,
      'operations_commerce_order_candidate_lines',
      'operations_commerce_current_planning_lines'
    );
    IF revised_definition IS DISTINCT FROM authority.definition THEN
      EXECUTE revised_definition;
    END IF;
  END LOOP;
END;
$ocr_current_line_functions$;

-- Checkout quote matching is also a live demand consumer.  Once a promoted
-- candidate has an accepted revision, compute its shippable quantity family
-- exclusively from the current revision projection rather than the immutable
-- intake snapshot.
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
    SELECT line.external_variant_id, line.ordered_quantity
    FROM operations_commerce_current_planning_lines line
    WHERE line.organization_id = requested_organization_id
      AND line.order_candidate_id = requested_order_candidate_id
      AND line.requires_shipping
  ),
  grouped AS (
    SELECT external_variant_id, sum(ordered_quantity)::bigint AS total_quantity
    FROM source_lines
    WHERE external_variant_id IS NOT NULL
      AND ordered_quantity = trunc(ordered_quantity)
    GROUP BY external_variant_id
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM source_lines)
      OR EXISTS (
        SELECT 1 FROM source_lines
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
  END
$$;

DO $ocr_live_demand_catalog$
DECLARE
  unresolved_function text;
  missing_function text;
BEGIN
  SELECT string_agg(expected.name, ', ' ORDER BY expected.name)
    INTO missing_function
  FROM (VALUES
    ('validate_ops_fulfillment_allocation_integrity',
      'validate_ops_fulfillment_allocation_integrity()'),
    ('validate_ops_reservation_authority',
      'validate_ops_reservation_authority()'),
    ('validate_operations_fulfillment_execution',
      'validate_operations_fulfillment_execution()'),
    ('operations_provider_commitment_current_support',
      'operations_provider_commitment_current_support(uuid,uuid,uuid,uuid,uuid,numeric,text,uuid,uuid)'),
    ('validate_ops_plan_cartonization_evidence',
      'validate_ops_plan_cartonization_evidence()'),
    ('validate_ops_activation_canonical_plans',
      'validate_ops_activation_canonical_plans()'),
    ('operations_one_off_plan_package_set_is_exact',
      'operations_one_off_plan_package_set_is_exact(uuid,uuid,uuid)'),
    ('operations_one_off_package_snapshot_hash',
      'operations_one_off_package_snapshot_hash(uuid,uuid,uuid,uuid)'),
    ('validate_operations_cartonization_rate_profile_evidence_complete',
      'validate_operations_cartonization_rate_profile_evidence_complete()'),
    ('operations_sandbox_commerce_e2e_authorization_is_current',
      'operations_sandbox_commerce_e2e_authorization_is_current(uuid,uuid,uuid)'),
    ('operations_shopify_checkout_order_line_quantity_fingerprint',
      'operations_shopify_checkout_order_line_quantity_fingerprint(uuid,uuid)')
  ) expected(name, signature)
  WHERE to_regprocedure(expected.signature) IS NULL;
  IF missing_function IS NOT NULL THEN
    RAISE EXCEPTION 'revision current-demand catalog is missing functions: %',
      missing_function;
  END IF;

  SELECT string_agg(DISTINCT procedure.proname, ', ' ORDER BY procedure.proname)
    INTO unresolved_function
  FROM pg_proc procedure
  JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = current_schema()
    AND procedure.proname IN (
      'validate_ops_fulfillment_allocation_integrity',
      'validate_ops_reservation_authority',
      'validate_operations_fulfillment_execution',
      'operations_provider_commitment_current_support',
      'validate_ops_plan_cartonization_evidence',
      'validate_ops_activation_canonical_plans',
      'operations_one_off_plan_package_set_is_exact',
      'operations_one_off_package_snapshot_hash',
      'validate_operations_cartonization_rate_profile_evidence_complete',
      'operations_sandbox_commerce_e2e_authorization_is_current',
      'operations_shopify_checkout_order_line_quantity_fingerprint'
    )
    AND (
      pg_get_functiondef(procedure.oid) ~
        '(^|[^_])operations_order_lines([^A-Za-z0-9_]|$)'
      OR pg_get_functiondef(procedure.oid) ~
        '(^|[^_])operations_commerce_order_candidate_lines([^A-Za-z0-9_]|$)'
    );
  IF unresolved_function IS NOT NULL THEN
    RAISE EXCEPTION 'revision current-demand catalog still reads historical lines: %',
      unresolved_function;
  END IF;
END;
$ocr_live_demand_catalog$;

-- The canonical line identity is lifetime-stable. Remove/re-add reactivates
-- the same row; immutable application-line history carries revision versions.
DROP INDEX IF EXISTS ocr_order_lines_current_external_unique;
DO $ocr_lifetime_line_identity$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'operations_order_lines'::regclass
      AND constraint_row.conname = 'operations_order_lines_external_unique'
      AND constraint_row.contype = 'u'
      AND pg_get_constraintdef(constraint_row.oid) =
        'UNIQUE (order_id, external_line_id)'
  ) THEN
    RAISE EXCEPTION
      'operations_order_lines lifetime external identity constraint is missing';
  END IF;
END;
$ocr_lifetime_line_identity$;

CREATE OR REPLACE FUNCTION reject_operations_commerce_order_revision_read_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.protected_snapshot_purged_at IS NULL
     AND NEW.protected_snapshot_purged_at IS NOT NULL
     AND NEW.protected_snapshot_purged_at >= OLD.created_at
     AND NEW.party_snapshot_ciphertext IS NULL
     AND NEW.party_snapshot_iv IS NULL
     AND NEW.party_snapshot_tag IS NULL
     AND NEW.ship_to_snapshot_ciphertext IS NULL
     AND NEW.ship_to_snapshot_iv IS NULL
     AND NEW.ship_to_snapshot_tag IS NULL
     AND to_jsonb(NEW) - ARRAY[
       'party_snapshot_ciphertext', 'party_snapshot_iv', 'party_snapshot_tag',
       'ship_to_snapshot_ciphertext', 'ship_to_snapshot_iv',
       'ship_to_snapshot_tag', 'protected_snapshot_purged_at'
     ] = to_jsonb(OLD) - ARRAY[
       'party_snapshot_ciphertext', 'party_snapshot_iv', 'party_snapshot_tag',
       'ship_to_snapshot_ciphertext', 'ship_to_snapshot_iv',
       'ship_to_snapshot_tag', 'protected_snapshot_purged_at'
     ]
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'commerce order revision reads are immutable';
END;
$$;

DROP TRIGGER IF EXISTS operations_commerce_order_revision_reads_immutable
  ON operations_commerce_order_revision_reads;
CREATE TRIGGER operations_commerce_order_revision_reads_immutable
BEFORE UPDATE OR DELETE ON operations_commerce_order_revision_reads
FOR EACH ROW EXECUTE FUNCTION reject_operations_commerce_order_revision_read_mutation();

CREATE OR REPLACE FUNCTION purge_expired_ocr_protected_snapshots(
  p_limit integer DEFAULT 500
)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  purged_count integer;
BEGIN
  IF p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'protected snapshot purge limit is invalid';
  END IF;
  WITH due AS (
    SELECT id
    FROM operations_commerce_order_revision_reads
    WHERE protected_snapshot_purged_at IS NULL
      AND protected_snapshot_expires_at <= now()
    ORDER BY protected_snapshot_expires_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE operations_commerce_order_revision_reads read_evidence
  SET party_snapshot_ciphertext = NULL,
      party_snapshot_iv = NULL,
      party_snapshot_tag = NULL,
      ship_to_snapshot_ciphertext = NULL,
      ship_to_snapshot_iv = NULL,
      ship_to_snapshot_tag = NULL,
      protected_snapshot_purged_at = now()
  FROM due
  WHERE read_evidence.id = due.id;
  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

CREATE OR REPLACE FUNCTION protect_ocr_application_seal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snapshot jsonb;
  provider_order jsonb;
  provider_lines jsonb;
  expected_active_count integer;
  retained_count integer;
  changed_count integer;
  added_count integer;
  removed_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'commerce order revision applications are immutable';
  END IF;
  IF OLD.lifecycle_state <> 'building'
     OR NEW.lifecycle_state <> 'sealed'
     OR NEW.sealed_at IS NULL
     OR (to_jsonb(NEW) - 'lifecycle_state' - 'sealed_at') IS DISTINCT FROM
        (to_jsonb(OLD) - 'lifecycle_state' - 'sealed_at')
  THEN
    RAISE EXCEPTION 'commerce order revision applications are immutable';
  END IF;
  SELECT observation.normalized_snapshot
    INTO snapshot
  FROM operations_orders order_row
  JOIN operations_commerce_order_revision_targets target
    ON target.organization_id = order_row.organization_id
   AND target.order_id = order_row.id
  JOIN operations_commerce_order_revision_reads read_evidence
    ON read_evidence.organization_id = target.organization_id
   AND read_evidence.id = target.latest_read_id
  JOIN operations_commerce_order_revision_observations observation
    ON observation.organization_id = read_evidence.organization_id
   AND observation.id = read_evidence.observation_id
  WHERE order_row.organization_id = NEW.organization_id
    AND order_row.id = NEW.order_id
    AND order_row.status = 'imported'
    AND order_row.row_version = NEW.resulting_order_row_version
    AND order_row.integration_account_id = NEW.integration_account_id
    AND order_row.source_provider = NEW.provider
    AND target.id = NEW.target_id
    AND target.material_state = 'review_required'
    AND target.claim_state = 'ready'
    AND target.latest_observation_id = NEW.observation_id
    AND target.latest_read_id = NEW.read_id
    AND target.latest_source_hash = NEW.source_hash
    AND target.accepted_source_hash IS DISTINCT FROM NEW.source_hash
    AND read_evidence.source_hash = NEW.source_hash
    AND read_evidence.revision_hash = NEW.revision_hash
    AND read_evidence.canonical_row_version = NEW.expected_order_row_version
    AND read_evidence.provider_write_count = 0
    AND read_evidence.created_at >= now() - interval '35 minutes'
    AND observation.source_hash = NEW.source_hash
    AND observation.revision_hash = NEW.revision_hash
    AND observation.provider_write_count = 0
    AND ocr_order_has_zero_downstream(NEW.organization_id, NEW.order_id);
  IF snapshot IS NULL THEN
    RAISE EXCEPTION 'revision application seal lost exact current authority';
  END IF;
  provider_order := snapshot->'order';
  provider_lines := provider_order->'lines';
  SELECT count(*) INTO expected_active_count
  FROM jsonb_array_elements(provider_lines) provider_line
  WHERE (provider_line->>'currentQuantity')::numeric > 0;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(provider_lines) provider_line
    WHERE (provider_line->>'currentQuantity')::numeric > 0
      AND NOT EXISTS (
        SELECT 1
        FROM operations_commerce_order_revision_application_lines line
        JOIN operations_order_lines canonical_line
          ON canonical_line.organization_id = line.organization_id
         AND canonical_line.id = line.canonical_order_line_id
        JOIN operations_external_identifiers external
          ON external.organization_id = line.organization_id
         AND external.integration_account_id = line.integration_account_id
         AND external.entity_type = 'operations.order_line'
         AND external.entity_global_id = canonical_line.global_id
         AND external.external_id = line.external_line_id
         AND external.status = 'active'
        JOIN operations_product_mappings mapping
          ON mapping.organization_id = line.organization_id
         AND mapping.integration_account_id = line.integration_account_id
         AND mapping.pipeline_id = line.pipeline_id
         AND mapping.id = line.product_mapping_id
         AND mapping.product_id = line.product_id
         AND mapping.active = true
         AND mapping.external_product_id = line.external_product_id
         AND mapping.external_variant_id = line.external_variant_id
         AND COALESCE(mapping.channel_sku, '') = line.sku
        WHERE line.organization_id = NEW.organization_id
          AND line.application_id = NEW.id
          AND line.order_id = NEW.order_id
          AND line.active = true
          AND line.external_line_id = provider_line->>'externalLineId'
          AND line.external_product_id = provider_line->>'externalProductId'
          AND line.external_variant_id = provider_line->>'externalVariantId'
          AND line.sku = provider_line->>'sku'
          AND line.canonical_quantity =
            (provider_line->>'currentQuantity')::numeric
          AND line.unit_multiplier = COALESCE(
            (provider_line->>'unitMultiplier')::numeric,
            1
          )
          AND line.unit_price_minor =
            (provider_line->>'unitPriceMinor')::bigint
          AND line.requires_shipping =
            (provider_line->>'requiresShipping')::boolean
          AND line.line_source_hash = provider_line->>'sourceHash'
          AND canonical_line.order_id = NEW.order_id
          AND canonical_line.revision_retired_at IS NULL
          AND canonical_line.product_id = line.product_id
          AND canonical_line.external_line_id = line.external_line_id
          AND canonical_line.channel_sku = line.sku
          AND canonical_line.quantity = line.canonical_quantity
          AND canonical_line.unit_price_minor = line.unit_price_minor
          AND (
            line.requires_shipping = false
            OR EXISTS (
              SELECT 1
              FROM operations_commerce_variant_pack_mappings pack_mapping
              JOIN operations_product_pack_profile_versions profile_version
                ON profile_version.organization_id = pack_mapping.organization_id
               AND profile_version.pipeline_id = pack_mapping.pipeline_id
               AND profile_version.product_id = pack_mapping.product_id
               AND profile_version.id = pack_mapping.default_pack_profile_version_id
              JOIN operations_product_pack_profiles profile
                ON profile.organization_id = profile_version.organization_id
               AND profile.pipeline_id = profile_version.pipeline_id
               AND profile.product_id = profile_version.product_id
               AND profile.id = profile_version.profile_id
              WHERE pack_mapping.organization_id = line.organization_id
                AND pack_mapping.integration_account_id = line.integration_account_id
                AND pack_mapping.pipeline_id = line.pipeline_id
                AND pack_mapping.product_id = line.product_id
                AND pack_mapping.id = line.variant_pack_mapping_id
                AND pack_mapping.provider = NEW.provider
                AND pack_mapping.external_product_id = line.external_product_id
                AND pack_mapping.external_variant_id = line.external_variant_id
                AND pack_mapping.is_current = true
                AND pack_mapping.projection_state = 'current'
                AND pack_mapping.row_version = line.variant_pack_mapping_row_version
                AND profile_version.id = line.pack_profile_version_id
                AND profile_version.row_version = line.pack_profile_version_row_version
                AND profile_version.is_current = true
                AND profile_version.lifecycle_state IN ('customer_confirmed', 'active')
                AND profile.package_level = line.pack_profile_package_level
                AND profile_version.base_each_quantity =
                    line.pack_profile_base_each_quantity
                AND profile_version.gross_weight_grams = line.weight_grams
                AND profile_version.length_mm = line.length_mm
                AND profile_version.width_mm = line.width_mm
                AND profile_version.height_mm = line.height_mm
            )
          )
      )
  ) THEN
    RAISE EXCEPTION 'revision application active line set is incomplete';
  END IF;

  IF (SELECT count(*)
      FROM operations_commerce_order_revision_application_lines line
      WHERE line.organization_id = NEW.organization_id
        AND line.application_id = NEW.id AND line.active) <> expected_active_count
     OR EXISTS (
       SELECT 1 FROM operations_current_order_lines canonical_line
       WHERE canonical_line.organization_id = NEW.organization_id
         AND canonical_line.order_id = NEW.order_id
         AND NOT EXISTS (
           SELECT 1
           FROM operations_commerce_order_revision_application_lines line
           WHERE line.organization_id = canonical_line.organization_id
             AND line.application_id = NEW.id
             AND line.canonical_order_line_id = canonical_line.id
             AND line.active
         )
     )
     OR EXISTS (
       SELECT 1
       FROM operations_order_lines canonical_line
       WHERE canonical_line.organization_id = NEW.organization_id
         AND canonical_line.order_id = NEW.order_id
         AND canonical_line.revision_application_id = NEW.id
         AND NOT EXISTS (
           SELECT 1
           FROM operations_commerce_order_revision_application_lines line
           JOIN operations_external_identifiers external
             ON external.organization_id = line.organization_id
            AND external.integration_account_id = line.integration_account_id
            AND external.entity_type = 'operations.order_line'
            AND external.entity_global_id = canonical_line.global_id
            AND external.external_id = canonical_line.external_line_id
            AND external.status = 'retired'
           WHERE line.organization_id = canonical_line.organization_id
             AND line.application_id = NEW.id
             AND line.canonical_order_line_id = canonical_line.id
             AND line.active = false
             AND line.change_kind = 'removed'
         )
     )
  THEN
    RAISE EXCEPTION 'revision application canonical line authority is incomplete';
  END IF;

  SELECT
    count(*) FILTER (WHERE change_kind = 'retained'),
    count(*) FILTER (WHERE change_kind = 'changed'),
    count(*) FILTER (WHERE change_kind = 'added'),
    count(*) FILTER (WHERE change_kind = 'removed')
  INTO retained_count, changed_count, added_count, removed_count
  FROM operations_commerce_order_revision_application_lines line
  WHERE line.organization_id = NEW.organization_id
    AND line.application_id = NEW.id;
  IF NEW.change_summary->>'retainedLines' !~ '^[0-9]+$'
     OR NEW.change_summary->>'changedLines' !~ '^[0-9]+$'
     OR NEW.change_summary->>'addedLines' !~ '^[0-9]+$'
     OR NEW.change_summary->>'removedLines' !~ '^[0-9]+$'
     OR (NEW.change_summary->>'retainedLines')::integer <> retained_count
     OR (NEW.change_summary->>'changedLines')::integer <> changed_count
     OR (NEW.change_summary->>'addedLines')::integer <> added_count
     OR (NEW.change_summary->>'removedLines')::integer <> removed_count
  THEN
    RAISE EXCEPTION 'revision application change summary is incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM operations_orders order_row
    WHERE order_row.organization_id = NEW.organization_id
      AND order_row.id = NEW.order_id
      AND order_row.order_number = provider_order->>'orderNumber'
      AND order_row.currency = provider_order->>'currency'
      AND order_row.merchandise_total_minor = (
        SELECT sum(line.unit_price_minor * line.canonical_quantity)::bigint
        FROM operations_commerce_order_revision_application_lines line
        WHERE line.organization_id = NEW.organization_id
          AND line.application_id = NEW.id AND line.active
      )
      AND order_row.source_payload->>'sourceHash' = NEW.source_hash
      AND order_row.source_payload->>'revisionHash' = NEW.revision_hash
      AND order_row.source_payload->>'applicationGlobalId' = NEW.global_id
      AND order_row.source_payload->>'providerWrites' = '0'
      AND jsonb_typeof(order_row.source_payload->'amountsMinor') = 'object'
      AND order_row.source_payload #>> '{amountsMinor,subtotal}' =
          provider_order #>> '{money,subtotalMinor}'
      AND order_row.source_payload #>> '{amountsMinor,discount}' =
          provider_order #>> '{money,discountMinor}'
      AND order_row.source_payload #>> '{amountsMinor,shipping}' =
          provider_order #>> '{money,shippingMinor}'
      AND order_row.source_payload #>> '{amountsMinor,tax}' =
          provider_order #>> '{money,taxMinor}'
      AND order_row.source_payload #>> '{amountsMinor,total}' =
          provider_order #>> '{money,totalMinor}'
      AND jsonb_typeof(order_row.source_payload->'headerMoney') = 'object'
      AND order_row.source_payload #>> '{headerMoney,state}' = 'complete'
      AND order_row.source_payload #> '{headerMoney,unavailableFields}' =
          '[]'::jsonb
      AND order_row.source_payload #>> '{headerMoney,fulfillmentDemandUse}' =
          'exact_lines_only'
      AND order_row.source_payload #>> '{headerMoney,accountingUse}' =
          'eligible'
      AND (
        (
          NEW.provider = 'shopify'
          AND order_row.source_payload #>> '{headerMoney,customerChargeUse}' =
            'eligible'
        )
        OR (
          NEW.provider = 'faire'
          AND order_row.source_payload #>> '{headerMoney,customerChargeUse}' =
            'blocked'
        )
      )
      AND order_row.source_payload #>> '{headerMoney,reconciliationMode}' =
          provider_order #>> '{money,reconciliationMode}'
      AND jsonb_typeof(
        order_row.source_payload->'monetaryReconciliation'
      ) = 'object'
      AND order_row.source_payload #>>
          '{monetaryReconciliation,policyVersion}' =
          'commerce-money-reconciliation-v1'
      AND order_row.source_payload #>>
          '{monetaryReconciliation,basis}' =
          'remaining_unfulfilled_quantity_x_resolved_unit_price'
      AND order_row.source_payload #>>
          '{monetaryReconciliation,providerSubtotalMinor}' =
          provider_order #>> '{money,subtotalMinor}'
      AND order_row.source_payload #>>
          '{monetaryReconciliation,canonicalMerchandiseTotalMinor}' =
          order_row.merchandise_total_minor::text
      AND order_row.source_payload #>>
          '{monetaryReconciliation,varianceMinor}' =
          (order_row.merchandise_total_minor
            - (provider_order #>> '{money,subtotalMinor}')::bigint)::text
  ) THEN
    RAISE EXCEPTION 'revision application canonical header is incomplete';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ensure_ocr_application_sealed_at_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_commerce_order_revision_applications application
    JOIN operations_orders order_row
      ON order_row.organization_id = application.organization_id
     AND order_row.id = application.order_id
    JOIN operations_commerce_order_revision_targets target
      ON target.organization_id = application.organization_id
     AND target.order_id = application.order_id
    JOIN operations_commerce_order_candidates candidate
      ON candidate.organization_id = application.organization_id
     AND candidate.canonical_order_id = application.order_id
     AND candidate.workflow_state = 'promoted'
    WHERE application.organization_id = NEW.organization_id
      AND application.id = NEW.id
      AND application.lifecycle_state = 'sealed'
      AND application.sealed_at IS NOT NULL
      AND order_row.status = application.resulting_status
      AND order_row.row_version = application.resulting_order_row_version
      AND target.applied_application_id = application.id
      AND target.accepted_observation_id = application.observation_id
      AND target.accepted_read_id = application.read_id
      AND target.accepted_source_hash = application.source_hash
      AND target.accepted_revision_hash = application.revision_hash
      AND candidate.accepted_revision_application_id = application.id
  ) THEN
    RAISE EXCEPTION 'revision application must be sealed and installed exactly in its creation transaction';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS operations_commerce_order_revision_applications_immutable
  ON operations_commerce_order_revision_applications;
CREATE TRIGGER operations_commerce_order_revision_applications_immutable
BEFORE UPDATE OR DELETE ON operations_commerce_order_revision_applications
FOR EACH ROW EXECUTE FUNCTION protect_ocr_application_seal();

DROP TRIGGER IF EXISTS ocr_applications_sealed_at_commit
  ON operations_commerce_order_revision_applications;
CREATE CONSTRAINT TRIGGER ocr_applications_sealed_at_commit
AFTER INSERT ON operations_commerce_order_revision_applications
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_ocr_application_sealed_at_commit();

CREATE OR REPLACE FUNCTION reject_ocr_application_line_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commerce order revision application lines are immutable';
END;
$$;

DROP TRIGGER IF EXISTS operations_commerce_order_revision_application_lines_immutable
  ON operations_commerce_order_revision_application_lines;
CREATE TRIGGER operations_commerce_order_revision_application_lines_immutable
BEFORE UPDATE OR DELETE ON operations_commerce_order_revision_application_lines
FOR EACH ROW EXECUTE FUNCTION reject_ocr_application_line_mutation();

-- Replace only the exception-resolution guard.  Existing cancellation
-- authority remains unchanged; the new branch accepts a separately immutable
-- local-application disposition.
CREATE OR REPLACE FUNCTION protect_operations_commerce_order_revision_exception_resolution()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.exception_type = 'commerce_order_revision_required'
     AND NEW.status IN ('resolved', 'dismissed')
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       NEW.status = 'resolved'
       AND (
         (
           COALESCE(NEW.details->>'resolution' = 'provider_revision_current', false)
           AND EXISTS (
             SELECT 1
             FROM operations_commerce_order_revision_targets target
             JOIN operations_orders order_row
               ON order_row.organization_id = target.organization_id
              AND order_row.id = target.order_id
             JOIN operations_commerce_order_revision_reads read_evidence
               ON read_evidence.organization_id = target.organization_id
              AND read_evidence.id = target.latest_read_id
             JOIN operations_commerce_order_revision_observations observation
               ON observation.organization_id = read_evidence.organization_id
              AND observation.id = read_evidence.observation_id
             WHERE target.organization_id = NEW.organization_id
               AND target.order_id = NEW.order_id
               AND target.material_state = 'current'
               AND target.accepted_source_hash = read_evidence.source_hash
               AND target.latest_source_hash = read_evidence.source_hash
               AND read_evidence.global_id = NEW.details->>'readGlobalId'
               AND observation.global_id = NEW.details->>'observationGlobalId'
               AND read_evidence.source_hash = NEW.details->>'sourceHash'
               AND read_evidence.revision_hash = NEW.details->>'revisionHash'
               AND read_evidence.canonical_row_version = order_row.row_version
               AND observation.source_hash = read_evidence.source_hash
               AND observation.revision_hash = read_evidence.revision_hash
               AND read_evidence.provider_write_count = 0
               AND observation.provider_write_count = 0
           )
         )
         OR EXISTS (
           SELECT 1
           FROM operations_commerce_order_revision_dispositions disposition
           WHERE disposition.organization_id = NEW.organization_id
             AND disposition.order_id = NEW.order_id
         )
         OR EXISTS (
           SELECT 1
           FROM operations_commerce_order_revision_applications application
           JOIN operations_commerce_order_revision_targets target
             ON target.organization_id = application.organization_id
            AND target.id = application.target_id
            AND target.order_id = application.order_id
           JOIN operations_commerce_order_revision_reads read_evidence
             ON read_evidence.organization_id = application.organization_id
            AND read_evidence.id = application.read_id
           JOIN operations_commerce_order_revision_observations observation
             ON observation.organization_id = application.organization_id
            AND observation.id = application.observation_id
           JOIN operations_orders order_row
             ON order_row.organization_id = application.organization_id
            AND order_row.id = application.order_id
           WHERE application.organization_id = NEW.organization_id
             AND application.order_id = NEW.order_id
             AND application.global_id = NEW.details->>'applicationGlobalId'
             AND observation.global_id = NEW.details->>'observationGlobalId'
             AND read_evidence.global_id = NEW.details->>'readGlobalId'
             AND application.source_hash = NEW.details->>'sourceHash'
             AND application.revision_hash = NEW.details->>'revisionHash'
             AND NEW.details->>'resultingOrderRowVersion' ~ '^[0-9]+$'
             AND application.resulting_order_row_version =
                 (NEW.details->>'resultingOrderRowVersion')::bigint
             AND NEW.details->>'providerWrites' = '0'
             AND application.lifecycle_state = 'sealed'
             AND application.sealed_at IS NOT NULL
             AND application.provider_write_count = 0
             AND application.resulting_order_row_version = order_row.row_version
             AND target.applied_application_id = application.id
             AND target.accepted_observation_id = application.observation_id
             AND target.accepted_read_id = application.read_id
             AND target.accepted_source_hash = application.source_hash
             AND target.accepted_revision_hash = application.revision_hash
             AND target.material_state = 'current'
             AND read_evidence.observation_id = observation.id
             AND read_evidence.target_id = target.id
             AND read_evidence.order_id = target.order_id
             AND read_evidence.source_hash = application.source_hash
             AND read_evidence.revision_hash = application.revision_hash
             AND read_evidence.canonical_row_version =
               application.expected_order_row_version
             AND read_evidence.provider_write_count = 0
             AND observation.source_hash = application.source_hash
             AND observation.revision_hash = application.revision_hash
             AND observation.provider_write_count = 0
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

COMMENT ON TABLE operations_commerce_order_revision_reads IS
  'Immutable occurrence evidence for each exact provider read. Repeated unchanged provider content reuses its observation but receives a fresh canonical row-version and provider-read fence.';

COMMENT ON TABLE operations_commerce_order_revision_applications IS
  'Immutable authority and result evidence for a local-only exact provider revision applied to a wholly unstarted canonical order. No provider write is permitted.';

COMMENT ON TABLE operations_commerce_order_revision_application_lines IS
  'Immutable accepted revision-line projection. Original promoted candidate rows remain unchanged historical provider evidence.';

COMMENT ON VIEW operations_current_order_lines IS
  'Current canonical demand only. Revision-retired historical lines are excluded from every downstream execution consumer.';

COMMENT ON VIEW operations_commerce_current_planning_lines IS
  'Single promoted planning authority: legacy immutable candidate lines before any accepted revision, otherwise only the active immutable accepted revision projection.';
