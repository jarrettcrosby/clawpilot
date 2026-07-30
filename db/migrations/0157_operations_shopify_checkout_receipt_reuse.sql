-- Shopify may cache one CarrierService callback response and reuse it for
-- multiple checkouts whose typed request facts are identical. The receipt is
-- therefore immutable quote evidence, not a unique checkout-session token.
-- Each order must still resolve to exactly one matching receipt; multiple
-- matching receipts remain ambiguous and fail closed.

DROP INDEX IF EXISTS
  op_shopify_rate_reconciliations_receipt_match_unique;

CREATE INDEX IF NOT EXISTS
  op_shopify_rate_reconciliations_receipt_match_idx
  ON operations_shopify_checkout_rate_reconciliations (
    organization_id, receipt_id, created_at, id
  )
  WHERE outcome = 'matched';

CREATE TABLE IF NOT EXISTS
  operations_shopify_checkout_rate_reconciliation_supersessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('gsqc'),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    original_reconciliation_id uuid NOT NULL
      REFERENCES operations_shopify_checkout_rate_reconciliations(id)
      ON DELETE RESTRICT,
    receipt_id uuid NOT NULL,
    shopify_service_code text NOT NULL,
    candidate_set_hash text NOT NULL CHECK (
      candidate_set_hash ~ '^[a-f0-9]{64}$'
    ),
    match_method text NOT NULL DEFAULT 'shopify_exact_rate_v1' CHECK (
      match_method = 'shopify_exact_rate_v1'
    ),
    candidate_count integer NOT NULL DEFAULT 1 CHECK (
      candidate_count = 1
    ),
    match_evidence jsonb NOT NULL,
    idempotency_key text NOT NULL,
    provider_write_count integer NOT NULL DEFAULT 0 CHECK (
      provider_write_count = 0
    ),
    created_by text REFERENCES app_users(email) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ops_shopify_rate_recon_supersession_global_valid
      CHECK (global_id ~ '^gsqc[0-9]{7}$'),
    CONSTRAINT ops_shopify_rate_recon_supersession_global_unique
      UNIQUE (global_id),
    CONSTRAINT ops_shopify_rate_recon_supersession_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code)
      ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_rate_recon_supersession_offer_fkey
      FOREIGN KEY (
        organization_id, receipt_id, shopify_service_code
      )
      REFERENCES operations_shopify_checkout_rate_receipt_offers(
        organization_id, receipt_id, shopify_service_code
      ) ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_rate_recon_supersession_original_unique
      UNIQUE (organization_id, original_reconciliation_id),
    CONSTRAINT ops_shopify_rate_recon_supersession_neutral
      CHECK (
        operations_shopify_checkout_json_is_customer_neutral(
          match_evidence
        )
      ),
    CONSTRAINT ops_shopify_rate_recon_supersession_evidence_valid
      CHECK (
        length(btrim(idempotency_key)) BETWEEN 8 AND 200
        AND idempotency_key !~ '[[:cntrl:]]'
        AND shopify_service_code
          ~ '^clawpilot:(ups|fedex):[A-Za-z0-9][A-Za-z0-9._-]{0,56}$'
      )
  );

CREATE INDEX IF NOT EXISTS
  op_shopify_rate_reconciliation_supersession_receipt_idx
  ON operations_shopify_checkout_rate_reconciliation_supersessions (
    organization_id, receipt_id, created_at DESC, id DESC
  );

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
  SELECT
    receipt.id,
    receipt.global_id,
    offer.carrier_provider,
    offer.carrier_account_id,
    offer.carrier_rate_request_id,
    offer.service_code,
    offer.shopify_service_code,
    offer.offer_hash,
    offer.customer_charge_minor,
    offer.currency
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
    AND candidate.canonical_order_id IS NOT NULL
  ORDER BY receipt.global_id, offer.offer_hash;
$$;

CREATE OR REPLACE FUNCTION
  protect_ops_shopify_rate_recon_supersession()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  original_reconciliation
    operations_shopify_checkout_rate_reconciliations%ROWTYPE;
  exact_candidate_count integer;
  exact_candidate_set_hash text;
  selected_match record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify checkout rate reconciliation supersession evidence is immutable';
  END IF;

  SELECT * INTO original_reconciliation
  FROM operations_shopify_checkout_rate_reconciliations reconciliation
  WHERE reconciliation.id = NEW.original_reconciliation_id
  FOR SHARE;
  IF NOT FOUND
     OR original_reconciliation.organization_id
       IS DISTINCT FROM NEW.organization_id
     OR original_reconciliation.outcome NOT IN ('rejected', 'expired')
  THEN
    RAISE EXCEPTION
      'Only an exact cached-receipt match may supersede one rejected or expired Shopify checkout decision';
  END IF;

  SELECT
    count(*)::integer,
    encode(
      digest(
        COALESCE(
          string_agg(
            receipt_global_id || ':' || offer_hash,
            E'\n'
            ORDER BY receipt_global_id, offer_hash
          ),
          ''
        ),
        'sha256'
      ),
      'hex'
    )
    INTO exact_candidate_count, exact_candidate_set_hash
  FROM operations_shopify_checkout_rate_match_candidates(
    NEW.organization_id,
    original_reconciliation.order_candidate_id,
    true
  );
  IF exact_candidate_count IS DISTINCT FROM 1
     OR NEW.candidate_count IS DISTINCT FROM 1
     OR NEW.candidate_set_hash IS DISTINCT FROM exact_candidate_set_hash
  THEN
    RAISE EXCEPTION
      'Cached Shopify reconciliation recovery requires exactly one current immutable receipt match';
  END IF;

  SELECT * INTO selected_match
  FROM operations_shopify_checkout_rate_match_candidates(
    NEW.organization_id,
    original_reconciliation.order_candidate_id,
    true
  );
  IF NEW.receipt_id IS DISTINCT FROM selected_match.receipt_id
     OR NEW.shopify_service_code
       IS DISTINCT FROM selected_match.offer_shopify_service_code
     OR NEW.idempotency_key
       IS DISTINCT FROM original_reconciliation.idempotency_key
     OR NOT (
       NEW.match_evidence @> jsonb_build_object(
         'version',
         'shopify-exact-rate-reconciliation-v2-cached-reuse',
         'recoveryReason',
         'pre_0157_cached_receipt_exclusivity',
         'supersedesReconciliationGlobalId',
         original_reconciliation.global_id,
         'exactCandidateCount',
         1,
         'candidateSetHash',
         exact_candidate_set_hash,
         'matchedReceiptGlobalId',
         selected_match.receipt_global_id,
         'providerWrites',
         0
       )
     )
  THEN
    RAISE EXCEPTION
      'Cached Shopify reconciliation recovery evidence is stale or mismatched';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_ops_shopify_rate_reconciliation_supersession_write
  ON operations_shopify_checkout_rate_reconciliation_supersessions;
CREATE TRIGGER
  protect_ops_shopify_rate_reconciliation_supersession_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_checkout_rate_reconciliation_supersessions
FOR EACH ROW EXECUTE FUNCTION
  protect_ops_shopify_rate_recon_supersession();

-- The old matcher treated a receipt already linked to another order as
-- consumed. Re-evaluate only retained rejected/expired decisions. Exactly one
-- current match creates a new immutable decision; zero or multiple matches
-- remain untouched and fail closed.
WITH recoverable AS (
  SELECT
    original.id AS original_reconciliation_id,
    original.global_id AS original_reconciliation_global_id,
    original.organization_id,
    original.order_candidate_id,
    original.idempotency_key,
    original.created_by,
    candidate.subtotal_minor,
    exact_match.receipt_id,
    exact_match.receipt_global_id,
    exact_match.offer_shopify_service_code,
    exact_match.offer_hash,
    count(*) OVER (
      PARTITION BY original.organization_id, original.id
    )::integer AS exact_candidate_count
  FROM operations_shopify_checkout_rate_reconciliations original
  JOIN operations_commerce_order_candidates candidate
    ON candidate.organization_id = original.organization_id
   AND candidate.id = original.order_candidate_id
  CROSS JOIN LATERAL
    operations_shopify_checkout_rate_match_candidates(
      original.organization_id,
      original.order_candidate_id,
      true
    ) exact_match
  WHERE original.outcome IN ('rejected', 'expired')
),
eligible AS (
  SELECT
    recoverable.*,
    encode(
      digest(
        recoverable.receipt_global_id || ':' || recoverable.offer_hash,
        'sha256'
      ),
      'hex'
    ) AS candidate_set_hash,
    (
      SELECT count(*)::integer
      FROM operations_shopify_checkout_rate_match_candidates(
        recoverable.organization_id,
        recoverable.order_candidate_id,
        false
      )
    ) AS potential_candidate_count
  FROM recoverable
  WHERE recoverable.exact_candidate_count = 1
)
INSERT INTO
  operations_shopify_checkout_rate_reconciliation_supersessions (
    organization_id, original_reconciliation_id, receipt_id,
    shopify_service_code, candidate_set_hash, match_method,
    candidate_count, match_evidence, idempotency_key, created_by
  )
SELECT
  eligible.organization_id,
  eligible.original_reconciliation_id,
  eligible.receipt_id,
  eligible.offer_shopify_service_code,
  eligible.candidate_set_hash,
  'shopify_exact_rate_v1',
  1,
  jsonb_build_object(
    'version', 'shopify-exact-rate-reconciliation-v2-cached-reuse',
    'recoveryReason', 'pre_0157_cached_receipt_exclusivity',
    'supersedesReconciliationGlobalId',
      eligible.original_reconciliation_global_id,
    'exactCandidateCount', 1,
    'potentialCandidateCount', eligible.potential_candidate_count,
    'candidateSetHash', eligible.candidate_set_hash,
    'matchedReceiptGlobalId', eligible.receipt_global_id,
    'zeroValueMerchandiseAllowed', eligible.subtotal_minor = 0,
    'providerWrites', 0
  ),
  eligible.idempotency_key,
  eligible.created_by
FROM eligible
ON CONFLICT (organization_id, original_reconciliation_id) DO NOTHING;

CREATE OR REPLACE VIEW
  operations_shopify_checkout_rate_current_reconciliations
AS
SELECT
  CASE
    WHEN supersession.id IS NULL THEN original.id
    ELSE supersession.id
  END AS id,
  COALESCE(supersession.global_id, original.global_id) AS global_id,
  original.organization_id,
  original.integration_account_id,
  original.order_candidate_id,
  COALESCE(supersession.receipt_id, original.receipt_id) AS receipt_id,
  original.order_id,
  original.source_external_order_id,
  original.source_order_created_at,
  original.source_line_quantity_fingerprint,
  original.source_destination_fingerprint,
  original.source_currency,
  original.source_shipping_charge_minor,
  original.source_shopify_service_code,
  COALESCE(
    supersession.candidate_set_hash,
    original.candidate_set_hash
  ) AS candidate_set_hash,
  CASE
    WHEN supersession.id IS NULL
    THEN original.selected_carrier_provider
    ELSE selected_offer.carrier_provider
  END AS selected_carrier_provider,
  CASE
    WHEN supersession.id IS NULL
    THEN original.selected_carrier_account_id
    ELSE selected_offer.carrier_account_id
  END AS selected_carrier_account_id,
  CASE
    WHEN supersession.id IS NULL
    THEN original.selected_carrier_rate_request_id
    ELSE selected_offer.carrier_rate_request_id
  END AS selected_carrier_rate_request_id,
  CASE
    WHEN supersession.id IS NULL
    THEN original.selected_service_code
    ELSE selected_offer.service_code
  END AS selected_service_code,
  CASE
    WHEN supersession.id IS NULL
    THEN original.selected_offer_hash
    ELSE selected_offer.offer_hash
  END AS selected_offer_hash,
  CASE
    WHEN supersession.id IS NULL
    THEN original.selected_customer_charge_minor
    ELSE selected_offer.customer_charge_minor
  END AS selected_customer_charge_minor,
  CASE
    WHEN supersession.id IS NULL
    THEN original.selected_currency
    ELSE selected_offer.currency
  END AS selected_currency,
  CASE
    WHEN supersession.id IS NULL THEN original.outcome
    ELSE 'matched'
  END AS outcome,
  COALESCE(supersession.match_method, original.match_method)
    AS match_method,
  COALESCE(supersession.candidate_count, original.candidate_count)
    AS candidate_count,
  COALESCE(supersession.match_evidence, original.match_evidence)
    AS match_evidence,
  COALESCE(supersession.idempotency_key, original.idempotency_key)
    AS idempotency_key,
  COALESCE(
    supersession.provider_write_count,
    original.provider_write_count
  ) AS provider_write_count,
  COALESCE(supersession.created_by, original.created_by) AS created_by,
  COALESCE(supersession.created_at, original.created_at) AS created_at
FROM operations_shopify_checkout_rate_reconciliations original
LEFT JOIN
  operations_shopify_checkout_rate_reconciliation_supersessions
    supersession
  ON supersession.organization_id = original.organization_id
 AND supersession.original_reconciliation_id = original.id
LEFT JOIN operations_shopify_checkout_rate_receipt_offers selected_offer
  ON selected_offer.organization_id = supersession.organization_id
 AND selected_offer.receipt_id = supersession.receipt_id
 AND selected_offer.shopify_service_code
   = supersession.shopify_service_code;

COMMENT ON TABLE
  operations_shopify_checkout_rate_reconciliation_supersessions IS
  'Append-only exact-match successors for pre-0157 rejected or expired decisions that excluded a Shopify-cached receipt already linked to another order. Original decisions remain immutable; zero or multiple matches are never superseded.';

COMMENT ON VIEW
  operations_shopify_checkout_rate_current_reconciliations IS
  'One current Shopify checkout decision per order candidate. A database-verified cached-receipt successor is projected as matched while its original rejected or expired evidence remains append-only.';

COMMENT ON TABLE operations_shopify_checkout_rate_reconciliations IS
  'Append-only order-to-quote decisions. One immutable receipt may support multiple orders only when Shopify reused identical cached request facts. Pre-0157 rejected or expired evidence is retained and may have one database-verified append-only successor; multiple receipt matches remain ambiguous.';
