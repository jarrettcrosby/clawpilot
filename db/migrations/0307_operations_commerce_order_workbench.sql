-- Keep provider order intake immutable while giving Operations an ordinary,
-- editable working copy. Protected ship-to values stay encrypted and no row
-- in this table represents or authorizes a provider write.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog, pg_temp;

CREATE TABLE operations_commerce_order_workbench (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  external_order_id text NOT NULL,
  canonical_order_id uuid,
  accepted_provider_source_hash text NOT NULL
    CHECK (accepted_provider_source_hash ~ '^[a-f0-9]{64}$'),
  accepted_provider_updated_at timestamptz,
  ship_to_edit_state text NOT NULL CHECK (ship_to_edit_state IN (
    'provider_snapshot',
    'local_missing',
    'local_incomplete',
    'local_carrier_ready'
  )),
  ship_to_ciphertext bytea,
  ship_to_iv bytea,
  ship_to_tag bytea,
  ship_to_hash text,
  ship_to_source_hash text,
  ship_to_encryption_version integer,
  sync_state text NOT NULL DEFAULT 'provider_snapshot' CHECK (sync_state IN (
    'provider_snapshot',
    'local_only',
    'provider_sync_pending',
    'provider_synced',
    'provider_sync_failed'
  )),
  last_command_receipt_id uuid NOT NULL,
  last_idempotency_key text NOT NULL,
  last_request_hash text NOT NULL CHECK (
    last_request_hash ~ '^[a-f0-9]{64}$'
  ),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_order_workbench_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_order_workbench_candidate_fkey
    FOREIGN KEY (organization_id, integration_account_id, candidate_id)
    REFERENCES operations_commerce_order_candidates(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_order_workbench_order_fkey
    FOREIGN KEY (organization_id, canonical_order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_order_workbench_receipt_fkey
    FOREIGN KEY (organization_id, last_command_receipt_id)
    REFERENCES operations_command_receipts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_order_workbench_external_valid CHECK (
    length(btrim(external_order_id)) BETWEEN 1 AND 512
    AND external_order_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_commerce_order_workbench_key_valid CHECK (
    length(btrim(last_idempotency_key)) BETWEEN 8 AND 200
    AND last_idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_commerce_order_workbench_ship_to_valid CHECK (
    (
      ship_to_edit_state = 'provider_snapshot'
      AND ship_to_ciphertext IS NULL
      AND ship_to_iv IS NULL
      AND ship_to_tag IS NULL
      AND ship_to_hash IS NULL
      AND ship_to_source_hash IS NULL
      AND ship_to_encryption_version IS NULL
      AND sync_state = 'provider_snapshot'
    )
    OR (
      ship_to_edit_state IN (
        'local_missing', 'local_incomplete', 'local_carrier_ready'
      )
      AND ship_to_ciphertext IS NOT NULL
      AND ship_to_iv IS NOT NULL
      AND ship_to_tag IS NOT NULL
      AND ship_to_hash ~ '^[a-f0-9]{64}$'
      AND ship_to_source_hash ~ '^[a-f0-9]{64}$'
      AND ship_to_encryption_version = 1
      AND sync_state <> 'provider_snapshot'
    )
  ),
  CONSTRAINT operations_commerce_order_workbench_external_unique
    UNIQUE (organization_id, integration_account_id, external_order_id),
  CONSTRAINT operations_commerce_order_workbench_candidate_unique
    UNIQUE (organization_id, integration_account_id, candidate_id),
  CONSTRAINT operations_commerce_order_workbench_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE INDEX operations_commerce_order_workbench_updated_idx
  ON operations_commerce_order_workbench (
    organization_id, updated_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION validate_operations_commerce_order_workbench()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  prior_candidate_global_id text;
  refresh_receipt_valid boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.external_order_id,
    NEW.created_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.external_order_id,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'Commerce order working copy accepted provider binding is immutable';
  END IF;

  IF TG_OP = 'UPDATE' AND ROW(
    NEW.candidate_id,
    NEW.accepted_provider_source_hash,
    NEW.accepted_provider_updated_at
  ) IS DISTINCT FROM ROW(
    OLD.candidate_id,
    OLD.accepted_provider_source_hash,
    OLD.accepted_provider_updated_at
  ) THEN
    SELECT candidate.global_id
      INTO prior_candidate_global_id
    FROM public.operations_commerce_order_candidates candidate
    WHERE candidate.organization_id = OLD.organization_id
      AND candidate.integration_account_id = OLD.integration_account_id
      AND candidate.id = OLD.candidate_id
      AND candidate.external_order_id = OLD.external_order_id;

    SELECT EXISTS (
      SELECT 1
      FROM public.operations_command_receipts receipt
      WHERE receipt.organization_id = NEW.organization_id
        AND receipt.id = NEW.last_command_receipt_id
        AND receipt.command_type =
          'operations.commerce_order_workbench.refresh'
        AND receipt.status = 'processing'
        AND receipt.target_global_id = prior_candidate_global_id
        AND receipt.request_hash = NEW.last_request_hash
    ) INTO refresh_receipt_valid;

    IF NOT refresh_receipt_valid THEN
      RAISE EXCEPTION
        'Commerce order working copy accepted provider binding is immutable';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.operations_commerce_order_candidates candidate
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.integration_account_id = NEW.integration_account_id
      AND candidate.id = NEW.candidate_id
      AND candidate.external_order_id = NEW.external_order_id
  ) THEN
    RAISE EXCEPTION
      'Commerce order working copy does not match its tenant candidate';
  END IF;

  IF (
    TG_OP = 'INSERT'
    OR NEW.accepted_provider_source_hash
      IS DISTINCT FROM OLD.accepted_provider_source_hash
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.operations_commerce_order_candidates accepted_candidate
    WHERE accepted_candidate.organization_id = NEW.organization_id
      AND accepted_candidate.integration_account_id
        = NEW.integration_account_id
      AND accepted_candidate.id = NEW.candidate_id
      AND accepted_candidate.source_hash
        = NEW.accepted_provider_source_hash
  ) THEN
    RAISE EXCEPTION
      'Commerce order working copy accepted provider version is invalid';
  END IF;

  IF NEW.ship_to_source_hash IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.operations_commerce_order_candidates source_candidate
    WHERE source_candidate.organization_id = NEW.organization_id
      AND source_candidate.integration_account_id
        = NEW.integration_account_id
      AND source_candidate.id = NEW.candidate_id
      AND source_candidate.source_hash = NEW.ship_to_source_hash
  ) THEN
    RAISE EXCEPTION
      'Commerce order working copy encryption source is invalid';
  END IF;

  IF NEW.canonical_order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.operations_orders canonical_order
    WHERE canonical_order.organization_id = NEW.organization_id
      AND canonical_order.integration_account_id
        = NEW.integration_account_id
      AND canonical_order.id = NEW.canonical_order_id
      AND canonical_order.external_order_id = NEW.external_order_id
  ) THEN
    RAISE EXCEPTION
      'Commerce order working copy canonical order is invalid';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_commerce_order_workbench
BEFORE INSERT OR UPDATE ON operations_commerce_order_workbench
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_commerce_order_workbench();

COMMENT ON TABLE operations_commerce_order_workbench IS
  'Encrypted, tenant-scoped local working copies for imported Shopify and Faire orders. Local edits never imply provider-write intent.';

COMMENT ON COLUMN
  operations_commerce_order_workbench.accepted_provider_source_hash IS
  'Provider revision accepted by the current explicit read-only refresh/rebase. It changes only with a matching durable refresh receipt.';

COMMENT ON COLUMN operations_commerce_order_workbench.candidate_id IS
  'Provider candidate bound to the working copy. A read-only refresh may rebind it only through the validated refresh receipt while retaining old candidate and audit evidence.';

COMMENT ON COLUMN operations_commerce_order_workbench.canonical_order_id IS
  'Set only after the bound candidate passes the existing validation and promotion gates. The Orders workbench suppresses the candidate row once this exact canonical link exists.';

COMMENT ON COLUMN operations_commerce_order_workbench.sync_state IS
  'Provider reconciliation status. The first release writes local_only only and creates zero provider-write intents.';
