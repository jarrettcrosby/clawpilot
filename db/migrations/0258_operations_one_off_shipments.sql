-- Native one-off shipment quotes and canonical planned-order creation.
--
-- A quote is immutable evidence. It can be consumed exactly once into a
-- canonical Operations order, but this slice never buys postage, creates a
-- carrier shipment, or materializes tracking.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('goq', 'operations.one_off_shipment_quote', 'One-off shipment quote'),
  ('goo', 'operations.one_off_shipment_quote_offer', 'One-off shipment quote offer')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

ALTER TABLE operations_orders
  DROP CONSTRAINT IF EXISTS operations_orders_order_type_check,
  ADD CONSTRAINT operations_orders_order_type_check
    CHECK (order_type IN (
      'standard', 'backorder', 'transfer', 'replacement', 'one_off'
    ));

ALTER TABLE operations_carrier_rate_requests
  DROP CONSTRAINT IF EXISTS
    operations_carrier_rate_requests_org_global_unique,
  ADD CONSTRAINT operations_carrier_rate_requests_org_global_unique
    UNIQUE (organization_id, global_id);

CREATE TABLE IF NOT EXISTS operations_one_off_shipment_quote_commands (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'completed', 'failed')),
  quote_id uuid,
  error_code text,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (organization_id, idempotency_key),
  CONSTRAINT operations_one_off_quote_command_key_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 160
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_one_off_quote_command_state_valid CHECK (
    (
      state = 'pending'
      AND quote_id IS NULL
      AND error_code IS NULL
      AND completed_at IS NULL
    ) OR (
      state = 'completed'
      AND quote_id IS NOT NULL
      AND error_code IS NULL
      AND completed_at IS NOT NULL
    ) OR (
      state = 'failed'
      AND quote_id IS NULL
      AND NULLIF(btrim(error_code), '') IS NOT NULL
      AND completed_at IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS operations_one_off_shipment_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('goq'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  inventory_pool_id uuid NOT NULL,
  receiving_location_id uuid NOT NULL,
  rate_environment text NOT NULL
    CHECK (rate_environment IN ('sandbox', 'production')),
  reference_number text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  requested_delivery_at timestamptz,
  destination_snapshot jsonb NOT NULL,
  destination_hash text NOT NULL CHECK (destination_hash ~ '^[a-f0-9]{64}$'),
  lines_snapshot jsonb NOT NULL,
  lines_hash text NOT NULL CHECK (lines_hash ~ '^[a-f0-9]{64}$'),
  packages_snapshot jsonb NOT NULL,
  packages_hash text NOT NULL CHECK (packages_hash ~ '^[a-f0-9]{64}$'),
  required_carrier_providers text[] NOT NULL,
  provider_results_snapshot jsonb NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('succeeded', 'partial', 'failed')),
  idempotency_key text NOT NULL,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  sealed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_one_off_shipment_quotes_global_valid
    CHECK (global_id ~ '^goq(?:[0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_one_off_shipment_quotes_global_unique UNIQUE (global_id),
  CONSTRAINT operations_one_off_shipment_quotes_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_shipment_quotes_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_shipment_quotes_customer_fkey
    FOREIGN KEY (pipeline_id, customer_id)
    REFERENCES crm_organizations(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_shipment_quotes_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_shipment_quotes_pool_fkey
    FOREIGN KEY (organization_id, inventory_pool_id)
    REFERENCES operations_inventory_pools(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_shipment_quotes_location_fkey
    FOREIGN KEY (organization_id, receiving_location_id)
    REFERENCES operations_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_shipment_quotes_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_one_off_shipment_quotes_idempotency_unique
    UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_one_off_shipment_quotes_reference_present CHECK (
    length(btrim(reference_number)) BETWEEN 1 AND 120
    AND reference_number !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_one_off_shipment_quotes_snapshots_valid CHECK (
    jsonb_typeof(destination_snapshot) = 'object'
    AND jsonb_typeof(lines_snapshot) = 'array'
    AND jsonb_array_length(lines_snapshot) BETWEEN 1 AND 25
    AND jsonb_typeof(packages_snapshot) = 'array'
    AND jsonb_array_length(packages_snapshot) BETWEEN 1 AND 50
    AND jsonb_typeof(provider_results_snapshot) = 'object'
  ),
  CONSTRAINT operations_one_off_shipment_quotes_provider_set_valid CHECK (
    required_carrier_providers IN (
      ARRAY['ups_rest']::text[],
      ARRAY['fedex_rest']::text[],
      ARRAY['ups_rest', 'fedex_rest']::text[]
    )
  ),
  CONSTRAINT operations_one_off_shipment_quotes_dates_valid CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '24 hours'
    AND sealed_at >= created_at
  )
);

ALTER TABLE operations_one_off_shipment_quote_commands
  ADD CONSTRAINT operations_one_off_quote_command_quote_fkey
  FOREIGN KEY (organization_id, quote_id)
  REFERENCES operations_one_off_shipment_quotes(organization_id, id)
  ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS operations_one_off_shipment_quote_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('goo'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  quote_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  carrier_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('ups_rest', 'fedex_rest')),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  credential_version integer NOT NULL CHECK (credential_version > 0),
  service_code text NOT NULL,
  service_name text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  transit_days integer CHECK (transit_days BETWEEN 0 AND 365),
  estimated_delivery_at timestamptz,
  rate_evidence_global_id text NOT NULL,
  carrier_request_hash text NOT NULL CHECK (carrier_request_hash ~ '^[a-f0-9]{64}$'),
  carrier_response_hash text NOT NULL CHECK (carrier_response_hash ~ '^[a-f0-9]{64}$'),
  offer_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_one_off_shipment_quote_offers_global_valid
    CHECK (global_id ~ '^goo(?:[0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_one_off_shipment_quote_offers_global_unique UNIQUE (global_id),
  CONSTRAINT operations_one_off_shipment_quote_offers_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_shipment_quote_offers_quote_fkey
    FOREIGN KEY (organization_id, quote_id)
    REFERENCES operations_one_off_shipment_quotes(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_shipment_quote_offers_integration_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_shipment_quote_offers_carrier_account_fkey
    FOREIGN KEY (organization_id, integration_account_id, carrier_account_id)
    REFERENCES operations_carrier_accounts(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_shipment_quote_offers_rate_evidence_fkey
    FOREIGN KEY (organization_id, rate_evidence_global_id)
    REFERENCES operations_carrier_rate_requests(organization_id, global_id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_shipment_quote_offers_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_one_off_shipment_quote_offers_quote_id_unique
    UNIQUE (organization_id, quote_id, id),
  CONSTRAINT operations_one_off_shipment_quote_offers_service_unique
    UNIQUE (organization_id, quote_id, provider, service_code),
  CONSTRAINT operations_one_off_shipment_quote_offers_text_valid CHECK (
    length(btrim(service_code)) BETWEEN 1 AND 128
    AND service_code !~ '[[:cntrl:]]'
    AND length(btrim(service_name)) BETWEEN 1 AND 255
    AND service_name !~ '[[:cntrl:]]'
    AND jsonb_typeof(offer_snapshot) = 'object'
  )
);

CREATE OR REPLACE FUNCTION validate_operations_one_off_quote_offer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_one_off_shipment_quotes quote
    JOIN operations_carrier_rate_requests evidence
      ON evidence.organization_id = quote.organization_id
     AND evidence.global_id = NEW.rate_evidence_global_id
    WHERE quote.organization_id = NEW.organization_id
      AND quote.id = NEW.quote_id
      AND quote.rate_environment = NEW.environment
      AND quote.currency = NEW.currency
      AND NEW.provider = ANY(quote.required_carrier_providers)
      AND evidence.provider = NEW.provider
      AND evidence.integration_account_id = NEW.integration_account_id
      AND evidence.carrier_account_id = NEW.carrier_account_id
      AND evidence.credential_version = NEW.credential_version
      AND evidence.environment = NEW.environment
      AND evidence.purpose = 'cartonization_shipment_rate'
      AND evidence.status = 'succeeded'
      AND evidence.request_hash = NEW.carrier_request_hash
  ) THEN
    RAISE EXCEPTION
      'One-off quote offer must retain exact succeeded carrier-rate evidence';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_one_off_quote_offer_insert
  ON operations_one_off_shipment_quote_offers;
CREATE TRIGGER validate_operations_one_off_quote_offer_insert
BEFORE INSERT OR UPDATE ON operations_one_off_shipment_quote_offers
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_quote_offer();

CREATE OR REPLACE FUNCTION validate_operations_one_off_quote_seal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  successful_provider_count integer;
  required_provider text;
  provider_has_offer boolean;
  provider_result_status text;
BEGIN
  SELECT count(DISTINCT offer.provider)::integer
  INTO successful_provider_count
  FROM operations_one_off_shipment_quote_offers offer
  WHERE offer.organization_id = NEW.organization_id
    AND offer.quote_id = NEW.id;

  FOREACH required_provider IN ARRAY NEW.required_carrier_providers LOOP
    provider_has_offer := EXISTS (
      SELECT 1
      FROM operations_one_off_shipment_quote_offers offer
      WHERE offer.organization_id = NEW.organization_id
        AND offer.quote_id = NEW.id
        AND offer.provider = required_provider
    );
    provider_result_status :=
      NEW.provider_results_snapshot -> required_provider ->> 'status';
    IF provider_result_status NOT IN ('succeeded', 'failed')
       OR provider_has_offer IS DISTINCT FROM
          (provider_result_status = 'succeeded') THEN
      RAISE EXCEPTION
        'One-off quote provider result does not match retained offers';
    END IF;
  END LOOP;

  IF (
    NEW.status = 'succeeded'
    AND successful_provider_count
      = cardinality(NEW.required_carrier_providers)
  ) OR (
    NEW.status = 'partial'
    AND successful_provider_count > 0
    AND successful_provider_count
      < cardinality(NEW.required_carrier_providers)
  ) OR (
    NEW.status = 'failed'
    AND successful_provider_count = 0
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'One-off quote status does not match retained carrier offers';
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_one_off_quote_seal_insert
  ON operations_one_off_shipment_quotes;
CREATE CONSTRAINT TRIGGER validate_operations_one_off_quote_seal_insert
AFTER INSERT OR UPDATE ON operations_one_off_shipment_quotes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_quote_seal();

CREATE TABLE IF NOT EXISTS operations_one_off_shipment_quote_consumptions (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  quote_id uuid NOT NULL,
  order_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  reason text NOT NULL,
  consumed_by text REFERENCES app_users(email) ON DELETE SET NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, quote_id),
  CONSTRAINT operations_one_off_quote_consumptions_quote_fkey
    FOREIGN KEY (organization_id, quote_id)
    REFERENCES operations_one_off_shipment_quotes(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_quote_consumptions_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_quote_consumptions_offer_fkey
    FOREIGN KEY (organization_id, quote_id, offer_id)
    REFERENCES operations_one_off_shipment_quote_offers(
      organization_id, quote_id, id
    )
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_quote_consumptions_order_unique
    UNIQUE (organization_id, order_id),
  CONSTRAINT operations_one_off_quote_consumptions_reason_valid CHECK (
    length(btrim(reason)) BETWEEN 3 AND 500
    AND reason !~ '[[:cntrl:]]'
  )
);

CREATE INDEX IF NOT EXISTS operations_one_off_shipment_quotes_recent_idx
  ON operations_one_off_shipment_quotes (
    organization_id, created_at DESC, id
  );

CREATE INDEX IF NOT EXISTS operations_one_off_shipment_quote_offers_quote_idx
  ON operations_one_off_shipment_quote_offers (
    organization_id, quote_id, amount_minor, provider, service_code
  );

CREATE OR REPLACE FUNCTION protect_operations_one_off_quote_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'One-off shipment quote command reservations are immutable';
  END IF;
  IF OLD.state = 'pending'
     AND NEW.state IN ('completed', 'failed')
     AND NEW.organization_id = OLD.organization_id
     AND NEW.idempotency_key = OLD.idempotency_key
     AND NEW.request_hash = OLD.request_hash
     AND NEW.actor_email IS NOT DISTINCT FROM OLD.actor_email
     AND NEW.created_at = OLD.created_at
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'One-off shipment quote command permits only one terminal transition';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_one_off_quote_command_mutation
  ON operations_one_off_shipment_quote_commands;
CREATE TRIGGER protect_operations_one_off_quote_command_mutation
BEFORE UPDATE OR DELETE
ON operations_one_off_shipment_quote_commands
FOR EACH ROW EXECUTE FUNCTION protect_operations_one_off_quote_command();

DROP TRIGGER IF EXISTS protect_operations_one_off_shipment_quotes_mutation
  ON operations_one_off_shipment_quotes;
CREATE TRIGGER protect_operations_one_off_shipment_quotes_mutation
BEFORE UPDATE OR DELETE ON operations_one_off_shipment_quotes
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_one_off_quote_offers_mutation
  ON operations_one_off_shipment_quote_offers;
CREATE TRIGGER protect_operations_one_off_quote_offers_mutation
BEFORE UPDATE OR DELETE ON operations_one_off_shipment_quote_offers
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_one_off_quote_consumptions_mutation
  ON operations_one_off_shipment_quote_consumptions;
CREATE TRIGGER protect_operations_one_off_quote_consumptions_mutation
BEFORE UPDATE OR DELETE ON operations_one_off_shipment_quote_consumptions
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

COMMENT ON TABLE operations_one_off_shipment_quotes IS
  'Immutable recipient, line, parcel, inventory-source, and enabled-carrier snapshot for a native ClawPilot one-off shipment quote.';
COMMENT ON TABLE operations_one_off_shipment_quote_offers IS
  'Immutable read-only carrier offers retained for one exact one-off shipment quote; no row purchases postage or creates a shipment.';
COMMENT ON TABLE operations_one_off_shipment_quote_consumptions IS
  'Append-only proof that one quote and selected offer created one canonical planned Operations order.';
