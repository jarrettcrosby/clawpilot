-- Stable provider activity identities and append-only content receipts. Edited
-- comments/display names must not rewrite a sealed event or block order sync.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE operations_commerce_order_event_observations
  DROP CONSTRAINT operations_commerce_order_event_observations_event_kind_check;
ALTER TABLE operations_commerce_order_event_observations
  ADD CONSTRAINT commerce_order_event_kind_native_activity_valid CHECK (
    event_kind IN (
      'order_created', 'order_updated', 'order_cancelled', 'order_closed',
      'payment_updated', 'fulfillment_created', 'fulfillment_updated',
      'shipment_created', 'tracking_updated', 'refund_created', 'refund_updated',
      'return_created', 'return_updated', 'return_state_observed', 'provider_activity'
    )
  );

ALTER TABLE operations_commerce_order_observations
  ADD COLUMN native_activity_state text,
  ADD COLUMN native_activity_reason text,
  ADD COLUMN native_activity_fetched_count integer,
  ADD CONSTRAINT commerce_order_observation_native_activity_valid CHECK (
    (native_activity_state IS NULL AND native_activity_reason IS NULL
      AND native_activity_fetched_count IS NULL)
    OR (native_activity_state IS NOT NULL
      AND native_activity_state IN ('complete', 'partial', 'unavailable')
      AND native_activity_fetched_count BETWEEN 0 AND 500
      AND native_activity_fetched_count IS NOT NULL
      AND (native_activity_reason IS NULL OR (
        length(btrim(native_activity_reason)) BETWEEN 1 AND 255
        AND native_activity_reason !~ '[[:cntrl:]]'
      )))
  );

CREATE TABLE operations_commerce_order_native_activity_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  external_order_id text NOT NULL CHECK (
    length(btrim(external_order_id)) BETWEEN 1 AND 512
  ),
  base_event_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  source_revision_hash text NOT NULL CHECK (source_revision_hash ~ '^[a-f0-9]{64}$'),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  provider_action text,
  provider_message text,
  provider_actor_display_name text,
  sensitive_evidence_expires_at timestamptz NOT NULL,
  sensitive_evidence_redacted_at timestamptz,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT commerce_order_native_activity_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_native_activity_event_fkey
    FOREIGN KEY (organization_id, base_event_id)
    REFERENCES operations_commerce_order_event_observations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_native_activity_observation_fkey
    FOREIGN KEY (organization_id, observation_id)
    REFERENCES operations_commerce_order_observations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_native_activity_observation_unique
    UNIQUE (organization_id, base_event_id, observation_id),
  CONSTRAINT commerce_order_native_activity_evidence_unique
    UNIQUE (organization_id, base_event_id, evidence_hash),
  CONSTRAINT commerce_order_native_activity_text_valid CHECK (
    (provider_action IS NULL OR (
      length(btrim(provider_action)) BETWEEN 1 AND 255
      AND provider_action !~ '[[:cntrl:]]'
    ))
    AND (provider_message IS NULL OR (
      length(btrim(provider_message)) BETWEEN 1 AND 8000
      AND translate(provider_message, E'\n\r\t', '') !~ '[[:cntrl:]]'
    ))
    AND (provider_actor_display_name IS NULL OR (
      length(btrim(provider_actor_display_name)) BETWEEN 1 AND 255
      AND provider_actor_display_name !~ '[[:cntrl:]]'
    ))
    AND (sensitive_evidence_redacted_at IS NULL OR (
      provider_action IS NULL AND provider_message IS NULL
      AND provider_actor_display_name IS NULL
    ))
  )
);
CREATE INDEX idx_commerce_order_native_activity_latest
  ON operations_commerce_order_native_activity_evidence (
    organization_id, base_event_id, observed_at DESC, created_at DESC, id DESC
  );
CREATE INDEX idx_commerce_order_native_activity_expiry
  ON operations_commerce_order_native_activity_evidence (
    sensitive_evidence_expires_at, id
  ) WHERE sensitive_evidence_redacted_at IS NULL;

COMMENT ON TABLE operations_commerce_order_native_activity_evidence IS
  'Append-only provider-native action, message and display-name receipts. Names are explicit provider labels, never app actor_email or inferred picker identity. All content expires with the immutable base event and is excluded from permanent identity hashes.';
COMMENT ON COLUMN operations_commerce_order_observations.native_activity_state IS
  'Optional native-timeline read coverage. NULL preserves legacy observations; unavailable/partial is never represented as complete history.';

CREATE FUNCTION protect_commerce_order_native_activity_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  base operations_commerce_order_event_observations%ROWTYPE;
  parent operations_commerce_order_observations%ROWTYPE;
BEGIN
  SELECT * INTO base FROM operations_commerce_order_event_observations
  WHERE organization_id = NEW.organization_id AND id = NEW.base_event_id
  FOR UPDATE;
  IF NOT FOUND OR base.integration_account_id <> NEW.integration_account_id
     OR base.provider <> NEW.provider OR base.external_order_id <> NEW.external_order_id
     OR base.event_kind <> 'provider_activity' OR base.external_event_id IS NULL THEN
    RAISE EXCEPTION 'native activity evidence base event scope mismatch';
  END IF;
  SELECT * INTO parent FROM operations_commerce_order_observations
  WHERE organization_id = NEW.organization_id AND id = NEW.observation_id;
  IF NOT FOUND OR parent.integration_account_id <> NEW.integration_account_id
     OR parent.provider <> NEW.provider OR parent.external_order_id <> NEW.external_order_id
     OR parent.source_hash <> NEW.source_revision_hash
     OR parent.observed_at <> NEW.observed_at THEN
    RAISE EXCEPTION 'native activity evidence observation scope mismatch';
  END IF;
  IF NOT commerce_order_observation_accepts_children(NEW.organization_id, NEW.observation_id) THEN
    RAISE EXCEPTION 'native activity evidence observation session is sealed';
  END IF;
  IF NEW.sensitive_evidence_expires_at IS DISTINCT FROM base.sensitive_evidence_expires_at THEN
    RAISE EXCEPTION 'native activity evidence changes retained event expiry';
  END IF;
  IF base.sensitive_evidence_redacted_at IS NOT NULL
     OR base.sensitive_evidence_expires_at <= clock_timestamp()
     OR NEW.sensitive_evidence_redacted_at IS NOT NULL THEN
    RAISE EXCEPTION 'native activity evidence retention has expired';
  END IF;
  IF NEW.provider_action IS NULL AND NEW.provider_message IS NULL
     AND NEW.provider_actor_display_name IS NULL THEN
    RAISE EXCEPTION 'native activity evidence requires provider content';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER commerce_order_native_activity_evidence_lineage_guard
BEFORE INSERT ON operations_commerce_order_native_activity_evidence
FOR EACH ROW EXECUTE FUNCTION protect_commerce_order_native_activity_evidence();

CREATE FUNCTION reject_commerce_order_native_activity_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.sensitive_evidence_expires_at <= clock_timestamp()
     AND OLD.sensitive_evidence_redacted_at IS NULL
     AND NEW.sensitive_evidence_redacted_at IS NOT NULL
     AND NEW.provider_action IS NULL AND NEW.provider_message IS NULL
     AND NEW.provider_actor_display_name IS NULL
     AND (to_jsonb(NEW) - ARRAY[
       'provider_action', 'provider_message', 'provider_actor_display_name',
       'sensitive_evidence_redacted_at'
     ]::text[]) = (to_jsonb(OLD) - ARRAY[
       'provider_action', 'provider_message', 'provider_actor_display_name',
       'sensitive_evidence_redacted_at'
     ]::text[]) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'native activity evidence is immutable';
END;
$$;
CREATE TRIGGER commerce_order_native_activity_evidence_immutable
BEFORE UPDATE OR DELETE ON operations_commerce_order_native_activity_evidence
FOR EACH ROW EXECUTE FUNCTION reject_commerce_order_native_activity_evidence_mutation();

CREATE FUNCTION redact_expired_commerce_order_native_activity_evidence(p_limit integer DEFAULT 250)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  redacted integer;
BEGIN
  WITH candidates AS (
    SELECT id FROM operations_commerce_order_native_activity_evidence
    WHERE sensitive_evidence_expires_at <= clock_timestamp()
      AND sensitive_evidence_redacted_at IS NULL
    ORDER BY sensitive_evidence_expires_at, id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 250), 1), 1000)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE operations_commerce_order_native_activity_evidence evidence
  SET provider_action = NULL, provider_message = NULL, provider_actor_display_name = NULL,
      sensitive_evidence_redacted_at = clock_timestamp()
  FROM candidates WHERE evidence.id = candidates.id;
  GET DIAGNOSTICS redacted = ROW_COUNT;
  RETURN redacted;
END;
$$;
ALTER FUNCTION protect_commerce_order_native_activity_evidence()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION reject_commerce_order_native_activity_evidence_mutation()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION redact_expired_commerce_order_native_activity_evidence(integer)
  SET search_path = pg_catalog, public, pg_temp;

-- The optional native timeline adds at most two read-only requests to the
-- original three-request Shopify exact read. Keep Faire at two and the general
-- observation ceiling at eight. A webhook acknowledgment must account for its
-- actual immutable completion receipt, not a guessed constant. Retained replay
-- observations may have a different earlier read count, so that older count is
-- not substituted for the receipt's current attempt count.
DO $$
DECLARE
  old_constraint text;
BEGIN
  SELECT installed_constraint.conname INTO STRICT old_constraint
  FROM pg_catalog.pg_constraint installed_constraint
  JOIN pg_catalog.pg_attribute installed_column
    ON installed_column.attrelid = installed_constraint.conrelid
   AND installed_column.attname = 'provider_read_count'
  WHERE installed_constraint.conrelid = 'operations_shopify_order_webhook_reads'::regclass
    AND installed_constraint.contype = 'c'
    AND installed_constraint.conkey = ARRAY[installed_column.attnum]::smallint[]
    AND pg_catalog.pg_get_constraintdef(installed_constraint.oid)
        = 'CHECK ((provider_read_count = 3))';
  EXECUTE format('ALTER TABLE operations_shopify_order_webhook_reads DROP CONSTRAINT %I', old_constraint);
END;
$$;
ALTER TABLE operations_shopify_order_webhook_reads
  ADD CONSTRAINT shopify_order_webhook_read_count_native_activity_valid
  CHECK (provider_read_count BETWEEN 3 AND 5);

-- Preserve every existing Store-sync authority, lease and transition fence.
-- As in migration 0298, each narrow replacement must match exactly once;
-- unexpected installed source fails the migration instead of silently widening
-- a different function. The resulting complete function bodies are attested.
DO $$
DECLARE
  definition text;
  previous text;
  replacement text;
BEGIN
  definition := pg_get_functiondef(
    'public.protect_commerce_order_observation_lineage()'::regprocedure
  );
  previous := $old$       OR NEW.provider_read_count <> (
         CASE
           WHEN NEW.provider = 'shopify' THEN 3
           ELSE 2
         END
       )$old$;
  replacement := $new$       OR NOT (
         (NEW.provider = 'shopify' AND NEW.provider_read_count BETWEEN 3 AND 5)
         OR (NEW.provider = 'faire' AND NEW.provider_read_count = 2)
       )$new$;
  IF (length(definition) - length(replace(definition, previous, '')))
      / length(previous) <> 1 THEN
    RAISE EXCEPTION 'native activity manual read-count guard source mismatch';
  END IF;
  definition := replace(definition, previous, replacement);
  previous := $old$       OR NEW.provider <> 'shopify'
       OR NEW.webhook_dirty_version IS NULL$old$;
  replacement := $new$       OR NEW.provider <> 'shopify'
       OR NEW.provider_read_count NOT BETWEEN 3 AND 5
       OR NEW.webhook_dirty_version IS NULL$new$;
  IF (length(definition) - length(replace(definition, previous, '')))
      / length(previous) <> 1 THEN
    RAISE EXCEPTION 'native activity webhook observation guard source mismatch';
  END IF;
  definition := replace(definition, previous, replacement);
  EXECUTE definition;

  definition := pg_get_functiondef(
    'public.protect_shopify_order_webhook_target()'::regprocedure
  );
  previous := $old$       OR NEW.provider_read_count <> OLD.provider_read_count + 3$old$;
  replacement := $new$       OR NEW.provider_read_count - OLD.provider_read_count NOT BETWEEN 3 AND 5$new$;
  IF (length(definition) - length(replace(definition, previous, '')))
      / length(previous) <> 1 THEN
    RAISE EXCEPTION 'native activity webhook completion count guard source mismatch';
  END IF;
  definition := replace(definition, previous, replacement);
  previous := $old$           AND read_row.provider_read_count = 3$old$;
  replacement := $new$           AND read_row.provider_read_count
                = NEW.provider_read_count - OLD.provider_read_count$new$;
  IF (length(definition) - length(replace(definition, previous, '')))
      / length(previous) <> 1 THEN
    RAISE EXCEPTION 'native activity webhook receipt count guard source mismatch';
  END IF;
  definition := replace(definition, previous, replacement);
  EXECUTE definition;
END;
$$;

COMMENT ON TABLE operations_shopify_order_webhook_reads IS
  'Immutable exact-read completion evidence for one captured Shopify order webhook dirty version. No raw/customer payload; three core plus up to two optional native-timeline reads, and zero provider writes.';
