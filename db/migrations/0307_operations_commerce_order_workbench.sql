-- Keep provider order intake immutable while giving Operations an ordinary,
-- editable working copy. Protected ship-to values stay encrypted and no row
-- in this table represents or authorizes a provider write.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION
  operations_commerce_order_workbench_line_drafts_valid(drafts jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  entry record;
  entry_count integer := 0;
BEGIN
  IF jsonb_typeof(drafts) IS DISTINCT FROM 'object'
  THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT item.key, item.value FROM jsonb_each(drafts) AS item
  LOOP
    entry_count := entry_count + 1;
    IF entry_count > 250 THEN
      RETURN false;
    END IF;
    IF entry.key !~ '^gcol(?:[0-9]{7}|[0-9a-v]{12})$'
       OR jsonb_typeof(entry.value) IS DISTINCT FROM 'object'
       OR entry.value - ARRAY[
         'productGlobalId', 'unitPriceMinor', 'currency',
         'packageProfileGlobalId'
       ]::text[] <> '{}'::jsonb
       OR NOT entry.value ?& ARRAY[
         'productGlobalId', 'unitPriceMinor', 'currency',
         'packageProfileGlobalId'
       ]::text[]
       OR COALESCE(
         entry.value->>'productGlobalId'
           !~ '^gp(?:[0-9]{7}|[0-9a-v]{12})$',
         true
       )
       OR (
         jsonb_typeof(entry.value->'unitPriceMinor') <> 'null'
         AND (
           jsonb_typeof(entry.value->'unitPriceMinor')
             IS DISTINCT FROM 'number'
           OR (entry.value->>'unitPriceMinor') !~ '^[0-9]{1,13}$'
           OR (entry.value->>'unitPriceMinor')::numeric > 9000000000000
         )
       )
       OR COALESCE(entry.value->>'currency' !~ '^[A-Z]{3}$', true)
       OR (
         entry.value->'packageProfileGlobalId' IS NOT NULL
         AND jsonb_typeof(entry.value->'packageProfileGlobalId') <> 'null'
         AND COALESCE(
           entry.value->>'packageProfileGlobalId'
             !~ '^gpp(?:[0-9]{7}|[0-9a-v]{12})$',
           true
         )
       ) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

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
  customer_global_id_draft text,
  requested_delivery_at_draft timestamptz,
  line_resolution_drafts jsonb NOT NULL DEFAULT '{}'::jsonb,
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
  CONSTRAINT operations_commerce_order_workbench_customer_draft_valid CHECK (
    customer_global_id_draft IS NULL
    OR customer_global_id_draft
      ~ '^ga(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_commerce_order_workbench_line_drafts_valid CHECK (
    operations_commerce_order_workbench_line_drafts_valid(
      line_resolution_drafts
    )
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
  invalid_line_draft boolean := false;
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

  IF NEW.customer_global_id_draft IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.operations_commerce_order_candidates candidate
    JOIN public.crm_organizations customer
      ON customer.pipeline_id = candidate.pipeline_id
     AND customer.reference_code = NEW.customer_global_id_draft
     AND customer.relationship_type = 'customer'
     AND COALESCE(lower(customer.source_payload->>'archived'), 'false')
         NOT IN ('true', '1', 'yes')
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.integration_account_id = NEW.integration_account_id
      AND candidate.id = NEW.candidate_id
  ) THEN
    RAISE EXCEPTION
      'Commerce order working copy customer draft is invalid';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM jsonb_each(NEW.line_resolution_drafts) draft(line_global_id, value)
    LEFT JOIN public.operations_commerce_order_candidate_lines candidate_line
      ON candidate_line.organization_id = NEW.organization_id
     AND candidate_line.integration_account_id = NEW.integration_account_id
     AND candidate_line.order_candidate_id = NEW.candidate_id
     AND candidate_line.global_id = draft.line_global_id
    LEFT JOIN public.crm_products product
      ON product.pipeline_id = candidate_line.pipeline_id
     AND product.reference_code = draft.value->>'productGlobalId'
     AND COALESCE(lower(product.source_payload->>'archived'), 'false')
         NOT IN ('true', '1', 'yes')
    LEFT JOIN public.operations_product_package_profiles profile
      ON profile.organization_id = NEW.organization_id
     AND profile.pipeline_id = candidate_line.pipeline_id
     AND profile.product_id = product.id
     AND profile.global_id = draft.value->>'packageProfileGlobalId'
     AND profile.active = true
    WHERE candidate_line.id IS NULL
       OR product.id IS NULL
       OR (
         draft.value->>'packageProfileGlobalId' IS NOT NULL
         AND profile.id IS NULL
       )
  ) INTO invalid_line_draft;
  IF invalid_line_draft THEN
    RAISE EXCEPTION
      'Commerce order working copy line draft is invalid';
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

COMMENT ON COLUMN
  operations_commerce_order_workbench.line_resolution_drafts IS
  'Local-only selections of real candidate lines, active CRM products, exact unit prices, and optional active product package profiles. Provider SKU and quantity evidence remain immutable.';
