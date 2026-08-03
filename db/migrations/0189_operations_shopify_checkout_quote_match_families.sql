-- Shopify may invoke the same CarrierService callback more than once while a
-- buyer is checking out. Treat materially identical immutable receipts as one
-- logical quote family, while preserving every receipt as evidence. A changed
-- config, credential, activation, policy, warehouse, algorithm, package plan,
-- selected carrier service, or selected economics remains a separate family
-- and therefore remains ambiguous at order reconciliation.

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_rate_match_candidate_facts(
    requested_organization_id uuid,
    requested_order_candidate_id uuid,
    enforce_reconciliation_deadline boolean DEFAULT true
  )
RETURNS TABLE (
  receipt_id uuid,
  receipt_global_id text,
  receipt_created_at timestamptz,
  offer_carrier_provider text,
  offer_carrier_account_id uuid,
  offer_carrier_rate_request_id uuid,
  offer_service_code text,
  offer_shopify_service_code text,
  offer_hash text,
  offer_customer_charge_minor bigint,
  offer_currency text,
  match_family_key text
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    receipt.id,
    receipt.global_id,
    receipt.created_at,
    offer.carrier_provider,
    offer.carrier_account_id,
    offer.carrier_rate_request_id,
    offer.service_code,
    offer.shopify_service_code,
    offer.offer_hash,
    offer.customer_charge_minor,
    offer.currency,
    encode(
      digest(
        jsonb_build_object(
          'requestFingerprint', receipt.request_fingerprint,
          'redactedRequestSnapshot', receipt.redacted_request_snapshot,
          'destinationFingerprint', receipt.destination_fingerprint,
          'carrierDestinationFingerprint',
            receipt.carrier_destination_fingerprint,
          'lineQuantityFingerprint', receipt.line_quantity_fingerprint,
          'receiptCurrency', receipt.currency,
          'configId', receipt.config_id::text,
          'configRowVersion', receipt.config_row_version,
          'credentialGeneration', receipt.credential_generation,
          'activationRevision', receipt.activation_revision,
          'activationState', receipt.activation_state,
          'policyRevision', receipt.policy_revision,
          'policyHash', receipt.policy_hash,
          'warehouseId', receipt.warehouse_id::text,
          'algorithmVersion', receipt.algorithm_version,
          'receiptPackageCount', receipt.package_count,
          'receiptPackagePlanHash', receipt.package_plan_hash,
          'carrierProvider', offer.carrier_provider,
          'carrierAccountId', offer.carrier_account_id::text,
          'carrierRequestHash', offer.carrier_request_hash,
          'carrierResponseRateHash', offer.carrier_response_rate_hash,
          'shopifyServiceCode', offer.shopify_service_code,
          'serviceCode', offer.service_code,
          'serviceName', offer.service_name,
          'carrierCostMinor', offer.carrier_cost_minor,
          'customerChargeMinor', offer.customer_charge_minor,
          'checkoutAdjustmentMinor', offer.checkout_adjustment_minor,
          'checkoutAdjustmentKind', offer.checkout_adjustment_kind,
          'checkoutAdjustmentReason', offer.checkout_adjustment_reason,
          'offerCurrency', offer.currency,
          'offerPackageCount', offer.package_count,
          'offerPackagePlanHash', offer.package_plan_hash,
          'minDeliveryDate', offer.min_delivery_date,
          'maxDeliveryDate', offer.max_delivery_date
        )::text,
        'sha256'
      ),
      'hex'
    )
  FROM operations_commerce_order_candidates candidate
  JOIN operations_shopify_checkout_rate_receipts receipt
    ON receipt.organization_id = candidate.organization_id
   AND receipt.integration_account_id = candidate.integration_account_id
   AND receipt.status = 'succeeded'
   AND receipt.destination_fingerprint
     = candidate.checkout_destination_fingerprint
   AND receipt.line_quantity_fingerprint
     = operations_shopify_checkout_order_line_quantity_fingerprint(
       candidate.organization_id,
       candidate.id
     )
   AND receipt.currency = candidate.currency_code
   AND (
     NOT enforce_reconciliation_deadline
     OR (
       candidate.provider_created_at
         >= date_trunc('second', receipt.created_at)
       AND candidate.provider_created_at
         <= receipt.reconciliation_deadline_at
     )
   )
  JOIN operations_shopify_checkout_rate_receipt_offers offer
    ON offer.organization_id = receipt.organization_id
   AND offer.receipt_id = receipt.id
   AND offer.shopify_service_code
     = candidate.checkout_shipping_service_code
   AND offer.customer_charge_minor = candidate.shipping_minor
   AND offer.currency = candidate.currency_code
  WHERE candidate.organization_id = requested_organization_id
    AND candidate.id = requested_order_candidate_id
    AND candidate.provider = 'shopify'
    AND candidate.workflow_state = 'promoted'
    AND candidate.canonical_order_id IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_rate_match_candidates(
    requested_organization_id uuid,
    requested_order_candidate_id uuid,
    enforce_reconciliation_deadline boolean DEFAULT true
  )
RETURNS TABLE (
  receipt_id uuid,
  receipt_global_id text,
  offer_carrier_provider text,
  offer_carrier_account_id uuid,
  offer_carrier_rate_request_id uuid,
  offer_service_code text,
  offer_shopify_service_code text,
  offer_hash text,
  offer_customer_charge_minor bigint,
  offer_currency text
)
LANGUAGE sql
STABLE
AS $$
  WITH ranked AS (
    SELECT
      facts.*,
      row_number() OVER (
        PARTITION BY facts.match_family_key
        ORDER BY
          facts.receipt_created_at DESC,
          facts.receipt_global_id DESC,
          facts.offer_hash DESC
      ) AS family_rank
    FROM operations_shopify_checkout_rate_match_candidate_facts(
      requested_organization_id,
      requested_order_candidate_id,
      enforce_reconciliation_deadline
    ) facts
  )
  SELECT
    ranked.receipt_id,
    ranked.receipt_global_id,
    ranked.offer_carrier_provider,
    ranked.offer_carrier_account_id,
    ranked.offer_carrier_rate_request_id,
    ranked.offer_service_code,
    ranked.offer_shopify_service_code,
    ranked.offer_hash,
    ranked.offer_customer_charge_minor,
    ranked.offer_currency
  FROM ranked
  WHERE ranked.family_rank = 1
  ORDER BY ranked.receipt_global_id, ranked.offer_hash;
$$;

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_rate_match_family_members(
    requested_organization_id uuid,
    requested_order_candidate_id uuid,
    requested_representative_receipt_id uuid,
    enforce_reconciliation_deadline boolean DEFAULT true
  )
RETURNS TABLE (receipt_global_id text)
LANGUAGE sql
STABLE
AS $$
  WITH candidate_facts AS (
    SELECT *
    FROM operations_shopify_checkout_rate_match_candidate_facts(
      requested_organization_id,
      requested_order_candidate_id,
      enforce_reconciliation_deadline
    )
  ), selected_family AS (
    SELECT facts.match_family_key
    FROM candidate_facts facts
    WHERE facts.receipt_id = requested_representative_receipt_id
    LIMIT 1
  )
  SELECT facts.receipt_global_id
  FROM candidate_facts facts
  JOIN selected_family family
    ON family.match_family_key = facts.match_family_key
  ORDER BY facts.receipt_created_at DESC, facts.receipt_global_id DESC;
$$;

COMMENT ON FUNCTION
  operations_shopify_checkout_rate_match_candidate_facts(
    uuid, uuid, boolean
  ) IS
  'All exact quote-to-order receipt candidates plus a material equivalence key. Inventory observation identity and receipt-local rate evidence IDs do not split an otherwise identical fully fenced package plan and selected offer.';

COMMENT ON FUNCTION
  operations_shopify_checkout_rate_match_candidates(
    uuid, uuid, boolean
  ) IS
  'One deterministic latest-before-order representative per materially distinct Shopify checkout quote family. Multiple distinct families remain ambiguous.';

COMMENT ON FUNCTION
  operations_shopify_checkout_rate_match_family_members(
    uuid, uuid, uuid, boolean
  ) IS
  'Every immutable receipt Global ID in the selected logical quote family, ordered with the deterministic representative first.';
