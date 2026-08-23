-- One exact Shopify test order may traverse the canonical local warehouse
-- workflow while the workspace remains Read only. Authority is immutable,
-- expiring, account/order/candidate/credential-bound, and never grants
-- production carrier evidence or a customer notification.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

DO $migration$
DECLARE
  constraint_name text;
BEGIN
  SELECT constraint_row.conname
  INTO constraint_name
  FROM pg_constraint constraint_row
  WHERE constraint_row.conrelid =
          'operations_sandbox_commerce_e2e_authorizations'::regclass
    AND constraint_row.contype = 'c'
    AND pg_get_constraintdef(constraint_row.oid)
          LIKE '%confirmation_statement_version%'
  LIMIT 1;
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION
      'Sandbox E2E confirmation-version constraint was not found';
  END IF;
  EXECUTE format(
    'ALTER TABLE operations_sandbox_commerce_e2e_authorizations DROP CONSTRAINT %I',
    constraint_name
  );
END
$migration$;

ALTER TABLE operations_sandbox_commerce_e2e_authorizations
  ADD CONSTRAINT
    operations_sandbox_e2e_confirm_version_check
  CHECK (confirmation_statement_version IN (
    'sandbox-commerce-e2e-v1',
    'shopify-test-store-canonical-e2e-v1'
  ));

-- Only one exceptional Read-only lane may be live in a workspace. The older
-- packed-order sandbox proof remains order-scoped and is not broadened.
CREATE UNIQUE INDEX IF NOT EXISTS
  operations_shopify_test_store_e2e_active_org_unique
ON operations_sandbox_commerce_e2e_authorizations (organization_id)
WHERE state = 'active'
  AND confirmation_statement_version =
        'shopify-test-store-canonical-e2e-v1';

CREATE TABLE IF NOT EXISTS operations_shopify_test_store_e2e_evidence (
  authorization_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  confirmation_hash text NOT NULL CHECK (
    confirmation_hash ~ '^[a-f0-9]{64}$'
  ),
  integration_account_id uuid NOT NULL,
  account_global_id text NOT NULL,
  external_account_id text NOT NULL,
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  activation_revision integer NOT NULL CHECK (activation_revision > 0),
  order_id uuid NOT NULL,
  order_global_id text NOT NULL,
  external_order_id text NOT NULL,
  initial_order_row_version bigint NOT NULL CHECK (
    initial_order_row_version >= 0
  ),
  order_candidate_id uuid NOT NULL,
  order_candidate_global_id text NOT NULL,
  order_candidate_row_version bigint NOT NULL CHECK (
    order_candidate_row_version >= 0
  ),
  order_candidate_source_revision text NOT NULL,
  order_candidate_source_hash text NOT NULL CHECK (
    order_candidate_source_hash ~ '^[a-f0-9]{64}$'
  ),
  provider_proof_version text NOT NULL CHECK (
    provider_proof_version = 'shopify-test-store-canonical-e2e-proof-v1'
  ),
  provider_proof_hash text NOT NULL CHECK (
    provider_proof_hash ~ '^[a-f0-9]{64}$'
  ),
  provider_order_updated_at timestamptz NOT NULL,
  provider_verified_at timestamptz NOT NULL,
  provider_test boolean NOT NULL CHECK (provider_test = true),
  authorization_idempotency_key text NOT NULL CHECK (
    length(authorization_idempotency_key) BETWEEN 1 AND 255
    AND authorization_idempotency_key !~ '[[:cntrl:]]'
  ),
  authorization_request_hash text NOT NULL CHECK (
    authorization_request_hash ~ '^[a-f0-9]{64}$'
  ),
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shopify_test_store_e2e_evidence_auth_fkey
    FOREIGN KEY (organization_id, authorization_id, confirmation_hash)
    REFERENCES operations_sandbox_commerce_e2e_authorizations(
      organization_id, id, confirmation_hash
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_test_store_e2e_evidence_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_test_store_e2e_evidence_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_test_store_e2e_evidence_candidate_fkey
    FOREIGN KEY (organization_id, order_candidate_id)
    REFERENCES operations_commerce_order_candidates(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_test_store_e2e_evidence_scope_unique
    UNIQUE (organization_id, authorization_id),
  CONSTRAINT operations_shopify_test_store_e2e_authorization_key_unique
    UNIQUE (organization_id, authorization_idempotency_key),
  CONSTRAINT operations_shopify_test_store_e2e_evidence_identity_valid CHECK (
    account_global_id ~ '^gia[0-9a-v]{7,12}$'
    AND order_global_id ~ '^gor[0-9a-v]{7,12}$'
    AND order_candidate_global_id ~ '^gcoc[0-9a-v]{7,12}$'
    AND external_order_id ~ '^gid://shopify/Order/[1-9][0-9]*$'
    AND external_account_id ~ '^gid://shopify/Shop/[1-9][0-9]*$'
  ),
  CONSTRAINT operations_shopify_test_store_e2e_evidence_text_valid CHECK (
    length(btrim(order_candidate_source_revision)) BETWEEN 1 AND 512
    AND order_candidate_source_revision !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_shopify_test_store_e2e_evidence_fresh CHECK (
    provider_verified_at >= provider_order_updated_at
    AND provider_verified_at >= created_at - interval '5 minutes'
    AND provider_verified_at <= created_at + interval '5 minutes'
  )
);

CREATE INDEX IF NOT EXISTS
  operations_shopify_test_store_e2e_evidence_order_idx
ON operations_shopify_test_store_e2e_evidence (
  organization_id, order_id, created_at DESC
);

CREATE OR REPLACE FUNCTION protect_shopify_test_store_e2e_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (
    NEW.created_at < statement_timestamp() - interval '1 minute'
    OR NEW.created_at > statement_timestamp() + interval '1 minute'
    OR NEW.provider_verified_at < statement_timestamp() - interval '5 minutes'
    OR NEW.provider_verified_at > statement_timestamp() + interval '1 minute'
  ) THEN
    RAISE EXCEPTION 'Shopify test-store proof is not fresh at insertion';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Shopify test-store E2E evidence is immutable';
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_test_store_e2e_evidence_write
  ON operations_shopify_test_store_e2e_evidence;
CREATE TRIGGER protect_shopify_test_store_e2e_evidence_write
BEFORE INSERT OR UPDATE OR DELETE ON operations_shopify_test_store_e2e_evidence
FOR EACH ROW EXECUTE FUNCTION protect_shopify_test_store_e2e_evidence();

CREATE TABLE IF NOT EXISTS
  operations_shopify_test_store_e2e_fulfillment_confirmations (
    authorization_id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    order_id uuid NOT NULL,
    confirmation_statement_version text NOT NULL CHECK (
      confirmation_statement_version = 'shopify-test-store-fulfillment-v1'
    ),
    confirmation_hash text NOT NULL CHECK (
      confirmation_hash ~ '^[a-f0-9]{64}$'
    ),
    label_evidence jsonb NOT NULL CHECK (
      jsonb_typeof(label_evidence) = 'array'
      AND jsonb_array_length(label_evidence) BETWEEN 1 AND 100
    ),
    label_evidence_hash text NOT NULL CHECK (
      label_evidence_hash ~ '^[a-f0-9]{64}$'
    ),
    idempotency_key text NOT NULL CHECK (
      length(idempotency_key) BETWEEN 1 AND 255
      AND idempotency_key !~ '[[:cntrl:]]'
    ),
    request_hash text NOT NULL CHECK (
      request_hash ~ '^[a-f0-9]{64}$'
    ),
    reason text NOT NULL,
    confirmed_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
    confirmed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operations_shopify_test_store_e2e_confirmation_auth_fkey
      FOREIGN KEY (organization_id, authorization_id)
      REFERENCES operations_shopify_test_store_e2e_evidence(
        organization_id, authorization_id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_shopify_test_store_e2e_confirmation_order_fkey
      FOREIGN KEY (organization_id, order_id)
      REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT operations_shopify_test_store_e2e_confirmation_key_unique
      UNIQUE (organization_id, idempotency_key),
    CONSTRAINT operations_shopify_test_store_e2e_confirmation_text_valid
      CHECK (
        length(btrim(reason)) BETWEEN 8 AND 500
        AND reason !~ '[[:cntrl:]]'
      )
  );

CREATE OR REPLACE FUNCTION protect_shopify_test_store_e2e_confirmation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.label_evidence_hash IS DISTINCT FROM encode(
      digest(convert_to(NEW.label_evidence::text, 'UTF8'), 'sha256'),
      'hex'
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.label_evidence) item
      WHERE jsonb_typeof(item) <> 'object'
        OR COALESCE(item->>'packageGlobalId', '')
             !~ '^gpa([0-9]{7}|[0-9a-v]{12})$'
        OR COALESCE(item->>'labelGlobalId', '')
             !~ '^glb([0-9]{7}|[0-9a-v]{12})$'
        OR length(COALESCE(item->>'trackingNumber', '')) NOT BETWEEN 1 AND 128
    ) THEN
      RAISE EXCEPTION 'Shopify test-store label evidence is invalid';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Shopify test-store fulfillment confirmation is immutable';
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_test_store_e2e_confirmation_write
  ON operations_shopify_test_store_e2e_fulfillment_confirmations;
CREATE TRIGGER protect_shopify_test_store_e2e_confirmation_write
BEFORE INSERT OR UPDATE OR DELETE
  ON operations_shopify_test_store_e2e_fulfillment_confirmations
FOR EACH ROW EXECUTE FUNCTION protect_shopify_test_store_e2e_confirmation();

CREATE OR REPLACE FUNCTION operations_shopify_test_store_e2e_is_current(
  requested_organization_id uuid,
  requested_authorization_id uuid,
  requested_order_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_sandbox_commerce_e2e_authorizations auth
    JOIN operations_shopify_test_store_e2e_evidence evidence
      ON evidence.organization_id = auth.organization_id
     AND evidence.authorization_id = auth.id
     AND evidence.confirmation_hash = auth.confirmation_hash
    JOIN operations_orders source_order
      ON source_order.organization_id = evidence.organization_id
     AND source_order.id = evidence.order_id
    JOIN operations_activation_scopes activation
      ON activation.organization_id = evidence.organization_id
    JOIN operations_integration_accounts account
      ON account.organization_id = evidence.organization_id
     AND account.id = evidence.integration_account_id
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN operations_commerce_order_candidates candidate
      ON candidate.organization_id = evidence.organization_id
     AND candidate.id = evidence.order_candidate_id
    WHERE auth.organization_id = requested_organization_id
      AND auth.id = requested_authorization_id
      AND auth.order_id = requested_order_id
      AND auth.state = 'active'
      AND auth.expires_at > statement_timestamp()
      AND auth.confirmation_statement_version =
            'shopify-test-store-canonical-e2e-v1'
      AND activation.state = 'read_only'
      AND activation.revision = evidence.activation_revision
      AND source_order.id = auth.order_id
      AND source_order.global_id = evidence.order_global_id
      AND source_order.source_provider = 'shopify'
      AND source_order.integration_account_id = account.id
      AND source_order.external_order_id = auth.external_order_id
      AND source_order.external_order_id = evidence.external_order_id
      AND source_order.row_version >= evidence.initial_order_row_version
      AND account.provider = 'shopify'
      AND account.integration_type = 'commerce'
      AND account.environment = 'sandbox'
      AND account.status = 'active'
      AND account.global_id = evidence.account_global_id
      AND account.external_account_id = evidence.external_account_id
      AND account.commerce_credential_generation =
            evidence.credential_generation
      AND credential.credential_version = evidence.credential_generation
      AND credential.external_account_id = evidence.external_account_id
      AND credential.verification_status = 'verified'
      AND candidate.integration_account_id = account.id
      AND candidate.canonical_order_id = source_order.id
      AND candidate.provider = 'shopify'
      AND candidate.workflow_state = 'promoted'
      AND candidate.test_order = true
      AND candidate.global_id = evidence.order_candidate_global_id
      AND candidate.row_version = evidence.order_candidate_row_version
      AND candidate.source_revision = evidence.order_candidate_source_revision
      AND candidate.source_hash = evidence.order_candidate_source_hash
      AND evidence.provider_test = true
  )
$$;

COMMENT ON TABLE operations_shopify_test_store_e2e_evidence IS
  'Fresh positive Shopify test-order proof and exact local Read-only workflow authority; never production carrier or customer-notification authority.';
COMMENT ON TABLE operations_shopify_test_store_e2e_fulfillment_confirmations IS
  'Second explicit owner/admin confirmation required before the exact authorized Shopify test fulfillmentCreate.';
