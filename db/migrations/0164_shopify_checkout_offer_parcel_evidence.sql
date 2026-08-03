-- Align immutable checkout-package evidence with the exact parcel shape sent
-- to the carrier adapters. ClawPilot-only package keys remain inside the
-- receipt and are intentionally excluded from provider request evidence.

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_carrier_request_parcel_snapshot(
    planning_method text,
    package_sequence integer,
    rated_outer_length_mm integer,
    rated_outer_width_mm integer,
    rated_outer_height_mm integer,
    gross_weight_grams integer
  )
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_build_object(
    'description',
      CASE planning_method
        WHEN 'self_package'
          THEN 'ClawPilot sealed case ' || package_sequence::text
        WHEN 'approved_recipe'
          THEN 'ClawPilot carton ' || package_sequence::text
        ELSE NULL
      END,
    'length', ceil(rated_outer_length_mm::numeric / 25.4)::integer,
    'width', ceil(rated_outer_width_mm::numeric / 25.4)::integer,
    'height', ceil(rated_outer_height_mm::numeric / 25.4)::integer,
    'dimensionUnit', 'IN',
    'weight', greatest(
      0.1::numeric,
      ceil(
        (gross_weight_grams::numeric / 453.59237::numeric) * 10
      ) / 10
    ),
    'weightUnit', 'LB'
  );
$$;

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_carrier_parcels_match(
    requested_organization_id uuid,
    requested_receipt_id uuid,
    provider_parcels jsonb
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    jsonb_typeof(provider_parcels) = 'array'
    AND provider_parcels = (
      SELECT jsonb_agg(
        operations_shopify_checkout_carrier_request_parcel_snapshot(
          package.planning_method,
          package.package_sequence,
          package.rated_outer_length_mm,
          package.rated_outer_width_mm,
          package.rated_outer_height_mm,
          package.gross_weight_grams
        )
        ORDER BY package.package_sequence, package.package_key
      )
      FROM operations_shopify_checkout_rate_receipt_packages package
      WHERE package.organization_id = requested_organization_id
        AND package.receipt_id = requested_receipt_id
    ),
    false
  );
$$;

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_checkout_rate_receipt_offer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_status text;
  requested_organization_id uuid;
  requested_receipt_id uuid;
  offer_ready boolean;
BEGIN
  requested_organization_id := COALESCE(
    NEW.organization_id, OLD.organization_id
  );
  requested_receipt_id := COALESCE(NEW.receipt_id, OLD.receipt_id);
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify checkout receipt child evidence is immutable';
  END IF;
  SELECT status INTO receipt_status
  FROM operations_shopify_checkout_rate_receipts
  WHERE organization_id = requested_organization_id
    AND id = requested_receipt_id;
  IF receipt_status IS DISTINCT FROM 'processing' THEN
    RAISE EXCEPTION
      'Shopify checkout receipt children require a processing claim';
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
     AND rate_evidence.status = 'succeeded'
     AND rate_evidence.request_hash = NEW.carrier_request_hash
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
      AND operations_shopify_checkout_carrier_rate_matches(
        rate_evidence.redacted_response,
        NEW.service_code,
        NEW.service_name,
        NEW.carrier_cost_minor,
        NEW.currency,
        NEW.carrier_response_rate_hash
      )
      AND (
        (
          NEW.carrier_provider = 'ups_rest'
          AND NEW.shopify_service_code LIKE 'clawpilot:ups:%'
        )
        OR (
          NEW.carrier_provider = 'fedex_rest'
          AND NEW.shopify_service_code LIKE 'clawpilot:fedex:%'
        )
      )
  ) INTO offer_ready;
  IF NOT offer_ready THEN
    RAISE EXCEPTION
      'Shopify checkout offer requires exact configured carrier and rate evidence';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_checkout_rate_receipt_offer_write
  ON operations_shopify_checkout_rate_receipt_offers;
CREATE TRIGGER
  protect_operations_shopify_checkout_rate_receipt_offer_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_checkout_rate_receipt_offers
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_shopify_checkout_rate_receipt_offer();
