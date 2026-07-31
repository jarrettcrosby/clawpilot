-- Retain one immutable carrier-attempt result for every carrier configured on
-- a successful Shopify checkout receipt. A carrier may degrade without
-- invalidating another carrier's usable whole-shipment offers, but the
-- degraded result must remain tied to the exact failed carrier-rate evidence.

CREATE TABLE IF NOT EXISTS
  operations_shopify_checkout_rate_receipt_provider_attempts (
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
    attempt_status text NOT NULL CHECK (
      attempt_status IN ('succeeded', 'degraded')
    ),
    failure_code text,
    attempt_hash text NOT NULL CHECK (
      attempt_hash ~ '^[a-f0-9]{64}$'
    ),
    attempt_snapshot jsonb NOT NULL,
    PRIMARY KEY (
      organization_id, receipt_id, carrier_provider
    ),
    CONSTRAINT
      op_shopify_checkout_provider_attempts_receipt_fkey
      FOREIGN KEY (organization_id, receipt_id)
      REFERENCES operations_shopify_checkout_rate_receipts(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      op_shopify_checkout_provider_attempts_account_fkey
      FOREIGN KEY (organization_id, carrier_account_id)
      REFERENCES operations_carrier_accounts(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT
      op_shopify_checkout_provider_attempts_rate_fkey
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
    CONSTRAINT
      op_shopify_checkout_provider_attempts_account_unique
      UNIQUE (organization_id, receipt_id, carrier_account_id),
    CONSTRAINT
      op_shopify_checkout_provider_attempts_neutral
      CHECK (
        operations_shopify_checkout_json_is_customer_neutral(
          attempt_snapshot
        )
      ),
    CONSTRAINT
      op_shopify_checkout_provider_attempts_state_valid
      CHECK (
        (
          attempt_status = 'succeeded'
          AND failure_code IS NULL
        )
        OR (
          attempt_status = 'degraded'
          AND failure_code IS NOT NULL
          AND length(btrim(failure_code)) BETWEEN 3 AND 128
          AND failure_code ~ '^[A-Z0-9_]+$'
        )
      )
  );

COMMENT ON TABLE
  operations_shopify_checkout_rate_receipt_provider_attempts IS
  'Immutable per-configured-carrier checkout attempt evidence; successful receipts may retain a failed carrier only when its exact failed rate request is linked.';

CREATE OR REPLACE FUNCTION
  protect_op_shopify_checkout_provider_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_status text;
  attempt_ready boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify checkout provider-attempt evidence is immutable';
  END IF;

  SELECT status INTO receipt_status
  FROM operations_shopify_checkout_rate_receipts
  WHERE organization_id = NEW.organization_id
    AND id = NEW.receipt_id;
  IF receipt_status IS DISTINCT FROM 'processing' THEN
    RAISE EXCEPTION
      'Shopify checkout provider attempts require a processing claim';
  END IF;

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
     AND rate_evidence.request_hash = NEW.carrier_request_hash
     AND rate_evidence.environment = 'sandbox'
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
      AND operations_shopify_checkout_carrier_parcels_match(
        receipt.organization_id,
        receipt.id,
        rate_evidence.redacted_request #> '{shipment,parcels}'
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
      AND (
        (
          NEW.attempt_status = 'succeeded'
          AND rate_evidence.status = 'succeeded'
          AND rate_evidence.error_code IS NULL
          AND NEW.failure_code IS NULL
        )
        OR (
          NEW.attempt_status = 'degraded'
          AND rate_evidence.status = 'failed'
          AND rate_evidence.error_code = NEW.failure_code
          AND rate_evidence.redacted_response #>>
            '{errorCode}' = NEW.failure_code
        )
      )
  ) INTO attempt_ready;

  IF NOT attempt_ready THEN
    RAISE EXCEPTION
      'Shopify checkout provider attempt requires exact configured carrier and rate evidence';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_op_shopify_checkout_provider_attempt_write
  ON operations_shopify_checkout_rate_receipt_provider_attempts;
CREATE TRIGGER
  protect_op_shopify_checkout_provider_attempt_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_checkout_rate_receipt_provider_attempts
FOR EACH ROW EXECUTE FUNCTION
  protect_op_shopify_checkout_provider_attempt();

CREATE OR REPLACE FUNCTION
  validate_op_shopify_checkout_attempt_finalization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_provider_count bigint;
  retained_attempt_count bigint;
  successful_attempt_count bigint;
  attempt_config_mismatch_count bigint;
  offer_attempt_mismatch_count bigint;
  successful_attempt_without_offer_count bigint;
  degraded_attempt_with_offer_count bigint;
BEGIN
  IF NEW.status <> 'succeeded' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO expected_provider_count
  FROM operations_shopify_carrier_service_config_carriers selected
  WHERE selected.organization_id = NEW.organization_id
    AND selected.config_id = NEW.config_id;

  SELECT count(*) INTO retained_attempt_count
  FROM operations_shopify_checkout_rate_receipt_provider_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.receipt_id = NEW.id;

  SELECT count(*) INTO successful_attempt_count
  FROM operations_shopify_checkout_rate_receipt_provider_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.receipt_id = NEW.id
    AND attempt.attempt_status = 'succeeded';

  SELECT count(*) INTO attempt_config_mismatch_count
  FROM operations_shopify_checkout_rate_receipt_provider_attempts attempt
  LEFT JOIN operations_shopify_carrier_service_config_carriers selected
    ON selected.organization_id = NEW.organization_id
   AND selected.config_id = NEW.config_id
   AND selected.carrier_provider = attempt.carrier_provider
   AND selected.carrier_account_id = attempt.carrier_account_id
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.receipt_id = NEW.id
    AND selected.carrier_provider IS NULL;

  SELECT count(*) INTO offer_attempt_mismatch_count
  FROM operations_shopify_checkout_rate_receipt_offers offer
  LEFT JOIN
    operations_shopify_checkout_rate_receipt_provider_attempts attempt
    ON attempt.organization_id = offer.organization_id
   AND attempt.receipt_id = offer.receipt_id
   AND attempt.carrier_provider = offer.carrier_provider
   AND attempt.carrier_account_id = offer.carrier_account_id
   AND attempt.carrier_rate_request_id = offer.carrier_rate_request_id
   AND attempt.attempt_status = 'succeeded'
  WHERE offer.organization_id = NEW.organization_id
    AND offer.receipt_id = NEW.id
    AND attempt.carrier_provider IS NULL;

  SELECT count(*) INTO successful_attempt_without_offer_count
  FROM operations_shopify_checkout_rate_receipt_provider_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.receipt_id = NEW.id
    AND attempt.attempt_status = 'succeeded'
    AND NOT EXISTS (
      SELECT 1
      FROM operations_shopify_checkout_rate_receipt_offers offer
      WHERE offer.organization_id = attempt.organization_id
        AND offer.receipt_id = attempt.receipt_id
        AND offer.carrier_provider = attempt.carrier_provider
        AND offer.carrier_account_id = attempt.carrier_account_id
        AND offer.carrier_rate_request_id =
          attempt.carrier_rate_request_id
    );

  SELECT count(*) INTO degraded_attempt_with_offer_count
  FROM operations_shopify_checkout_rate_receipt_provider_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.receipt_id = NEW.id
    AND attempt.attempt_status = 'degraded'
    AND EXISTS (
      SELECT 1
      FROM operations_shopify_checkout_rate_receipt_offers offer
      WHERE offer.organization_id = attempt.organization_id
        AND offer.receipt_id = attempt.receipt_id
        AND offer.carrier_provider = attempt.carrier_provider
    );

  IF expected_provider_count < 1
     OR retained_attempt_count <> expected_provider_count
     OR successful_attempt_count < 1
     OR attempt_config_mismatch_count <> 0
     OR offer_attempt_mismatch_count <> 0
     OR successful_attempt_without_offer_count <> 0
     OR degraded_attempt_with_offer_count <> 0
  THEN
    RAISE EXCEPTION
      'Shopify checkout receipt provider-attempt evidence is incomplete';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_op_shopify_checkout_attempt_finalization
  ON operations_shopify_checkout_rate_receipts;
CREATE TRIGGER
  validate_op_shopify_checkout_attempt_finalization
BEFORE UPDATE ON operations_shopify_checkout_rate_receipts
FOR EACH ROW EXECUTE FUNCTION
  validate_op_shopify_checkout_attempt_finalization();
