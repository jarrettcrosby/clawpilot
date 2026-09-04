-- Additive URL evidence for retained provider events. An enrichment is not a
-- second fulfillment/tracking lifecycle event and never rewrites its base hash.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE operations_commerce_order_tracking_url_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  external_order_id text NOT NULL CHECK (
    length(btrim(external_order_id)) BETWEEN 1 AND 512
  ),
  base_event_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  source_revision_hash text NOT NULL CHECK (
    source_revision_hash ~ '^[a-f0-9]{64}$'
  ),
  provider_updated_at timestamptz NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  tracking_url text,
  tracking_number text,
  provider_actor_fingerprint text,
  sensitive_evidence_expires_at timestamptz NOT NULL,
  sensitive_evidence_redacted_at timestamptz,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT commerce_order_tracking_url_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_order_tracking_url_event_fkey
    FOREIGN KEY (organization_id, base_event_id)
    REFERENCES operations_commerce_order_event_observations(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_order_tracking_url_observation_fkey
    FOREIGN KEY (organization_id, observation_id)
    REFERENCES operations_commerce_order_observations(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_order_tracking_url_observation_unique
    UNIQUE (organization_id, base_event_id, observation_id),
  CONSTRAINT commerce_order_tracking_url_evidence_unique
    UNIQUE (organization_id, base_event_id, evidence_hash),
  CONSTRAINT commerce_order_tracking_url_revision_unique
    UNIQUE (organization_id, base_event_id, provider_updated_at),
  CONSTRAINT commerce_order_tracking_url_value_valid CHECK (
    tracking_url IS NULL OR (
      length(btrim(tracking_url)) BETWEEN 1 AND 2048
      AND tracking_url ~ '^https?://'
      AND tracking_url !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT commerce_order_tracking_url_sensitive_valid CHECK (
    (tracking_number IS NULL
      OR length(btrim(tracking_number)) BETWEEN 1 AND 512)
    AND (provider_actor_fingerprint IS NULL
      OR provider_actor_fingerprint ~ '^[a-f0-9]{64}$')
    AND (sensitive_evidence_redacted_at IS NULL OR (
      tracking_url IS NULL AND tracking_number IS NULL
      AND provider_actor_fingerprint IS NULL
    ))
  )
);

CREATE INDEX idx_commerce_order_tracking_url_latest
  ON operations_commerce_order_tracking_url_evidence (
    organization_id, base_event_id, observed_at DESC, created_at DESC, id DESC
  );
CREATE INDEX idx_commerce_order_tracking_url_expiry
  ON operations_commerce_order_tracking_url_evidence (
    sensitive_evidence_expires_at, id
  ) WHERE sensitive_evidence_redacted_at IS NULL;

COMMENT ON TABLE operations_commerce_order_tracking_url_evidence IS
  'Append-only positive source-revision URL evidence for an immutable provider event. NULL is reserved for expiry redaction, never inferred provider removal. No new provider lifecycle event or provider write.';

CREATE FUNCTION protect_commerce_order_tracking_url_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  base operations_commerce_order_event_observations%ROWTYPE;
  parent operations_commerce_order_observations%ROWTYPE;
  previous_url text;
  previous_revision timestamptz;
BEGIN
  IF NEW.tracking_url IS NULL THEN
    RAISE EXCEPTION 'tracking URL evidence requires an explicit provider URL';
  END IF;
  -- One lock serializes same-event enrichments and expiry maintenance. Callers
  -- retain their normal account/order lock ordering and do not upgrade SHARE.
  SELECT * INTO base
  FROM operations_commerce_order_event_observations
  WHERE organization_id = NEW.organization_id AND id = NEW.base_event_id
  FOR UPDATE;
  IF NOT FOUND OR base.integration_account_id <> NEW.integration_account_id
     OR base.provider <> NEW.provider
     OR base.external_order_id <> NEW.external_order_id THEN
    RAISE EXCEPTION 'tracking URL evidence base event scope mismatch';
  END IF;
  SELECT * INTO parent FROM operations_commerce_order_observations
  WHERE organization_id = NEW.organization_id AND id = NEW.observation_id;
  IF NOT FOUND OR parent.integration_account_id <> NEW.integration_account_id
     OR parent.provider <> NEW.provider
     OR parent.external_order_id <> NEW.external_order_id
     OR parent.source_hash <> NEW.source_revision_hash
     OR parent.observed_at <> NEW.observed_at THEN
    RAISE EXCEPTION 'tracking URL evidence observation scope mismatch';
  END IF;
  -- The existing authority function verifies current credential generation,
  -- active owned account, policy, activation and the still-live read lease.
  IF NOT commerce_order_observation_accepts_children(
    NEW.organization_id, NEW.observation_id
  ) THEN
    RAISE EXCEPTION 'tracking URL evidence observation session is sealed';
  END IF;
  -- Derived, never client-asserted. The unique explicit-revision key also
  -- fences simultaneous inserts under repeatable-read snapshots.
  NEW.provider_updated_at := parent.provider_updated_at;
  IF NEW.tracking_number IS DISTINCT FROM base.tracking_number
     OR NEW.provider_actor_fingerprint IS DISTINCT FROM
          base.provider_actor_fingerprint
     OR NEW.sensitive_evidence_expires_at IS DISTINCT FROM
          base.sensitive_evidence_expires_at THEN
    RAISE EXCEPTION 'tracking URL evidence changes retained event evidence';
  END IF;
  IF base.sensitive_evidence_redacted_at IS NOT NULL
     OR base.sensitive_evidence_expires_at <= clock_timestamp()
     OR NEW.sensitive_evidence_redacted_at IS NOT NULL THEN
    RAISE EXCEPTION 'tracking URL evidence retention has expired';
  END IF;
  -- Nothing sensitive is added to durable identifiers. A provider order ID is
  -- retained identity, so it must not embed the newly submitted URL either.
  IF NEW.tracking_url IS NOT NULL
     AND position(NEW.tracking_url IN NEW.external_order_id) > 0 THEN
    RAISE EXCEPTION 'tracking URL cannot be embedded in durable identifiers';
  END IF;

  SELECT evidence.tracking_url, observation.provider_updated_at
    INTO previous_url, previous_revision
  FROM operations_commerce_order_tracking_url_evidence evidence
  JOIN operations_commerce_order_observations observation
    ON observation.organization_id = evidence.organization_id
   AND observation.id = evidence.observation_id
  WHERE evidence.organization_id = NEW.organization_id
    AND evidence.base_event_id = NEW.base_event_id
  ORDER BY observation.provider_updated_at DESC NULLS LAST,
           evidence.observed_at DESC, evidence.created_at DESC, evidence.id DESC
  LIMIT 1;
  IF NOT FOUND THEN
    previous_url := base.tracking_url;
    SELECT provider_updated_at INTO previous_revision
    FROM operations_commerce_order_observations
    WHERE organization_id = base.organization_id AND id = base.observation_id;
  END IF;
  IF NEW.tracking_url IS NOT DISTINCT FROM previous_url THEN
    RAISE EXCEPTION 'tracking URL evidence must describe a change';
  END IF;
  IF previous_url IS NULL AND NEW.tracking_url IS NOT NULL THEN
    IF parent.provider_updated_at IS NULL OR previous_revision IS NULL
       OR parent.provider_updated_at < previous_revision THEN
      RAISE EXCEPTION 'tracking URL enrichment has no non-regressing provider revision';
    END IF;
  ELSIF parent.provider_updated_at IS NULL OR previous_revision IS NULL
        OR parent.provider_updated_at <= previous_revision THEN
    RAISE EXCEPTION 'tracking URL change requires a newer provider revision';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commerce_order_tracking_url_evidence_lineage_guard
BEFORE INSERT ON operations_commerce_order_tracking_url_evidence
FOR EACH ROW EXECUTE FUNCTION protect_commerce_order_tracking_url_evidence();

CREATE FUNCTION reject_commerce_order_tracking_url_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.sensitive_evidence_expires_at <= clock_timestamp()
     AND OLD.sensitive_evidence_redacted_at IS NULL
     AND NEW.sensitive_evidence_redacted_at IS NOT NULL
     AND NEW.tracking_url IS NULL AND NEW.tracking_number IS NULL
     AND NEW.provider_actor_fingerprint IS NULL
     AND (to_jsonb(NEW) - ARRAY[
       'tracking_url', 'tracking_number', 'provider_actor_fingerprint',
       'sensitive_evidence_redacted_at'
     ]::text[]) = (to_jsonb(OLD) - ARRAY[
       'tracking_url', 'tracking_number', 'provider_actor_fingerprint',
       'sensitive_evidence_redacted_at'
     ]::text[]) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'tracking URL evidence is immutable';
END;
$$;

CREATE TRIGGER commerce_order_tracking_url_evidence_immutable
BEFORE UPDATE OR DELETE ON operations_commerce_order_tracking_url_evidence
FOR EACH ROW EXECUTE FUNCTION reject_commerce_order_tracking_url_evidence_mutation();

CREATE FUNCTION redact_expired_commerce_order_tracking_url_evidence(
  p_limit integer DEFAULT 250
)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  redacted integer;
BEGIN
  WITH candidates AS (
    SELECT id FROM operations_commerce_order_tracking_url_evidence
    WHERE sensitive_evidence_expires_at <= clock_timestamp()
      AND sensitive_evidence_redacted_at IS NULL
    ORDER BY sensitive_evidence_expires_at, id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 250), 1), 1000)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE operations_commerce_order_tracking_url_evidence evidence
  SET tracking_url = NULL, tracking_number = NULL,
      provider_actor_fingerprint = NULL,
      sensitive_evidence_redacted_at = clock_timestamp()
  FROM candidates WHERE evidence.id = candidates.id;
  GET DIAGNOSTICS redacted = ROW_COUNT;
  RETURN redacted;
END;
$$;

ALTER FUNCTION protect_commerce_order_tracking_url_evidence()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION reject_commerce_order_tracking_url_evidence_mutation()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION redact_expired_commerce_order_tracking_url_evidence(integer)
  SET search_path = pg_catalog, public, pg_temp;
