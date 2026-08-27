-- Imported ordinary-unit lines do not require Product-pack assignments, but
-- cartonization still needs a factual unit weight.  Keep that fact separate
-- from provider/catalog packaging projections: it is append-only, scoped to
-- the exact planning-line revision, and written by one idempotent Operations
-- command with no provider side effects.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO public.global_reference_entity_types (
  prefix, entity_type, display_name
) VALUES (
  'gouw', 'operations.order_unit_weight_fact',
  'Operations order unit weight fact'
)
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE public.operations_order_unit_weight_facts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  global_id text NOT NULL DEFAULT public.allocate_global_reference('gouw'),
  organization_id uuid NOT NULL
    REFERENCES public.workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  candidate_id uuid NOT NULL
    REFERENCES public.operations_commerce_order_candidates(id)
    ON DELETE RESTRICT,
  candidate_row_version bigint NOT NULL CHECK (candidate_row_version >= 0),
  order_id uuid NOT NULL
    REFERENCES public.operations_orders(id) ON DELETE RESTRICT,
  order_line_id uuid NOT NULL
    REFERENCES public.operations_order_lines(id) ON DELETE RESTRICT,
  planning_line_id uuid NOT NULL,
  planning_line_global_id text NOT NULL,
  candidate_line_id uuid,
  revision_application_line_id uuid,
  line_source_revision text NOT NULL,
  line_source_hash text NOT NULL CHECK (line_source_hash ~ '^[a-f0-9]{64}$'),
  fact_version integer NOT NULL CHECK (fact_version > 0),
  supersedes_fact_id uuid,
  unit_weight_grams integer NOT NULL
    CHECK (unit_weight_grams BETWEEN 1 AND 1000000),
  evidence_basis text NOT NULL DEFAULT 'operator_recorded_order_weight'
    CHECK (evidence_basis = 'operator_recorded_order_weight'),
  reason text NOT NULL CHECK (
    length(pg_catalog.btrim(reason)) BETWEEN 8 AND 500
    AND reason !~ '[[:cntrl:]]'
  ),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  fact_hash text NOT NULL CHECK (fact_hash ~ '^[a-f0-9]{64}$'),
  command_receipt_id uuid NOT NULL,
  recorded_by text NOT NULL
    REFERENCES public.app_users(email) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT operations_order_unit_weight_facts_global_valid CHECK (
    global_id ~ '^gouw(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_order_unit_weight_facts_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_order_unit_weight_facts_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES public.crm_reference_registry(reference_code)
    ON DELETE RESTRICT,
  CONSTRAINT operations_order_unit_weight_facts_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES public.operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_order_unit_weight_facts_pipeline_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES public.pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_order_unit_weight_facts_planning_line_fkey
    FOREIGN KEY (planning_line_global_id)
    REFERENCES public.crm_reference_registry(reference_code)
    ON DELETE RESTRICT,
  CONSTRAINT operations_order_unit_weight_facts_candidate_line_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id, candidate_line_id
    ) REFERENCES public.operations_commerce_order_candidate_lines (
      organization_id, integration_account_id, pipeline_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_order_unit_weight_facts_revision_line_fkey
    FOREIGN KEY (
      organization_id, order_id, revision_application_line_id
    ) REFERENCES public.operations_commerce_order_revision_application_lines (
      organization_id, order_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_order_unit_weight_facts_line_kind_valid CHECK (
    (candidate_line_id IS NOT NULL) <>
      (revision_application_line_id IS NOT NULL)
  ),
  CONSTRAINT operations_order_unit_weight_facts_receipt_fkey
    FOREIGN KEY (organization_id, command_receipt_id)
    REFERENCES public.operations_command_receipts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_order_unit_weight_facts_supersedes_fkey
    FOREIGN KEY (supersedes_fact_id)
    REFERENCES public.operations_order_unit_weight_facts(id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_order_unit_weight_facts_receipt_line_unique
    UNIQUE (organization_id, command_receipt_id, planning_line_global_id)
);

CREATE UNIQUE INDEX operations_order_unit_weight_facts_candidate_version_idx
  ON public.operations_order_unit_weight_facts (
    organization_id, candidate_id, candidate_line_id,
    planning_line_global_id, line_source_revision, line_source_hash,
    fact_version
  ) WHERE candidate_line_id IS NOT NULL;

CREATE UNIQUE INDEX operations_order_unit_weight_facts_revision_version_idx
  ON public.operations_order_unit_weight_facts (
    organization_id, candidate_id, revision_application_line_id,
    planning_line_global_id, line_source_revision, line_source_hash,
    fact_version
  ) WHERE revision_application_line_id IS NOT NULL;

CREATE UNIQUE INDEX operations_order_unit_weight_facts_candidate_first_idx
  ON public.operations_order_unit_weight_facts (
    organization_id, candidate_id, candidate_line_id,
    planning_line_global_id, line_source_revision, line_source_hash
  ) WHERE candidate_line_id IS NOT NULL
      AND supersedes_fact_id IS NULL;

CREATE UNIQUE INDEX operations_order_unit_weight_facts_revision_first_idx
  ON public.operations_order_unit_weight_facts (
    organization_id, candidate_id, revision_application_line_id,
    planning_line_global_id, line_source_revision, line_source_hash
  ) WHERE revision_application_line_id IS NOT NULL
      AND supersedes_fact_id IS NULL;

CREATE INDEX operations_order_unit_weight_facts_latest_idx
  ON public.operations_order_unit_weight_facts (
    organization_id, candidate_id, planning_line_global_id,
    line_source_revision, line_source_hash, fact_version DESC
  );

CREATE OR REPLACE FUNCTION public.validate_operations_order_unit_weight_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior public.operations_order_unit_weight_facts%ROWTYPE;
BEGIN
  IF NEW.fact_hash IS DISTINCT FROM pg_catalog.encode(
    public.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'candidateGlobalId', (
            SELECT candidate.global_id
            FROM public.operations_commerce_order_candidates candidate
            WHERE candidate.id = NEW.candidate_id
          ),
          'candidateRowVersion', NEW.candidate_row_version,
          'factGlobalId', NEW.global_id,
          'factVersion', NEW.fact_version,
          'lineGlobalId', NEW.planning_line_global_id,
          'lineSourceHash', NEW.line_source_hash,
          'lineSourceRevision', NEW.line_source_revision,
          'unitWeightGrams', NEW.unit_weight_grams
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ) THEN
    RAISE EXCEPTION 'Order unit weight fact hash is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.operations_commerce_current_planning_lines line
    JOIN public.operations_commerce_order_candidates candidate
      ON candidate.organization_id = line.organization_id
     AND candidate.id = line.order_candidate_id
    JOIN public.operations_orders order_row
      ON order_row.organization_id = candidate.organization_id
     AND order_row.id = candidate.canonical_order_id
    JOIN public.operations_current_order_lines order_line
      ON order_line.organization_id = order_row.organization_id
     AND order_line.order_id = order_row.id
     AND order_line.id = line.canonical_order_line_id
    LEFT JOIN public.operations_commerce_order_revision_application_lines
      revision_line
      ON revision_line.organization_id = line.organization_id
     AND revision_line.integration_account_id = line.integration_account_id
     AND revision_line.pipeline_id = line.pipeline_id
     AND revision_line.application_id =
           candidate.accepted_revision_application_id
     AND revision_line.planning_line_id = line.id
     AND revision_line.planning_global_id = line.global_id
     AND revision_line.active = true
    LEFT JOIN public.operations_product_channel_states channel_state
      ON channel_state.organization_id = line.organization_id
     AND channel_state.integration_account_id = line.integration_account_id
     AND channel_state.pipeline_id = line.pipeline_id
     AND channel_state.provider = line.provider
     AND channel_state.external_product_id = line.external_product_id
     AND channel_state.external_variant_id = line.external_variant_id
     AND channel_state.product_id = line.product_id
     AND channel_state.product_mapping_id = line.product_mapping_id
    WHERE line.organization_id = NEW.organization_id
      AND line.integration_account_id = NEW.integration_account_id
      AND line.pipeline_id = NEW.pipeline_id
      AND line.order_candidate_id = NEW.candidate_id
      AND line.id = NEW.planning_line_id
      AND line.global_id = NEW.planning_line_global_id
      AND line.source_revision = NEW.line_source_revision
      AND line.source_hash = NEW.line_source_hash
      AND line.canonical_order_line_id = NEW.order_line_id
      AND (
        (
          candidate.accepted_revision_application_id IS NULL
          AND NEW.candidate_line_id = line.id
          AND NEW.revision_application_line_id IS NULL
        ) OR (
          candidate.accepted_revision_application_id IS NOT NULL
          AND NEW.candidate_line_id IS NULL
          AND NEW.revision_application_line_id = revision_line.id
        )
      )
      AND candidate.workflow_state = 'promoted'
      AND candidate.row_version = NEW.candidate_row_version
      AND candidate.canonical_order_id = NEW.order_id
      AND order_row.status IN ('imported', 'validated', 'held')
      AND line.workflow_state = 'promoted'
      AND line.requires_shipping = true
      AND line.unfulfilled_quantity > 0
      AND line.unit_multiplier = 1
      AND line.mapping_state = 'resolved'
      AND line.product_id IS NOT NULL
      AND line.product_mapping_id IS NOT NULL
      AND line.packaging_state = 'not_required'
      AND line.packaging_source = 'none'
      AND line.commerce_variant_pack_mapping_id IS NULL
      AND line.pack_profile_version_id IS NULL
      AND (
        NEW.fact_version > 1
        OR (
          NOT (
            line.packaging_weight_source = 'provider_order'
            AND line.weight_grams > 0
          )
          AND COALESCE(channel_state.weight_grams, 0) = 0
        )
      )
      AND length(pg_catalog.btrim(line.source_revision)) > 0
      AND line.source_hash ~ '^[a-f0-9]{64}$'
  ) THEN
    RAISE EXCEPTION
      'Order unit weight requires one current exact ordinary-unit line';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.operations_command_receipts receipt
    JOIN public.operations_commerce_order_candidates candidate
      ON candidate.organization_id = receipt.organization_id
     AND candidate.id = NEW.candidate_id
    WHERE receipt.organization_id = NEW.organization_id
      AND receipt.id = NEW.command_receipt_id
      AND receipt.command_type = 'operations.record_order_unit_weights'
      AND receipt.status = 'processing'
      AND receipt.request_hash = NEW.request_hash
      AND receipt.target_global_id = candidate.global_id
      AND receipt.actor_email = NEW.recorded_by
  ) THEN
    RAISE EXCEPTION
      'Order unit weight requires its exact processing command receipt';
  END IF;

  IF NEW.fact_version = 1 THEN
    IF NEW.supersedes_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'First order unit weight fact cannot supersede another fact';
    END IF;
  ELSE
    SELECT * INTO prior
    FROM public.operations_order_unit_weight_facts fact
    WHERE fact.id = NEW.supersedes_fact_id
    FOR SHARE;
    IF NOT FOUND
      OR prior.organization_id IS DISTINCT FROM NEW.organization_id
      OR prior.candidate_id IS DISTINCT FROM NEW.candidate_id
      OR prior.candidate_line_id IS DISTINCT FROM NEW.candidate_line_id
      OR prior.revision_application_line_id IS DISTINCT FROM
           NEW.revision_application_line_id
      OR prior.planning_line_global_id IS DISTINCT FROM NEW.planning_line_global_id
      OR prior.line_source_revision IS DISTINCT FROM NEW.line_source_revision
      OR prior.line_source_hash IS DISTINCT FROM NEW.line_source_hash
      OR prior.fact_version + 1 IS DISTINCT FROM NEW.fact_version
      OR EXISTS (
        SELECT 1
        FROM public.operations_order_unit_weight_facts newer
        WHERE newer.supersedes_fact_id = prior.id
      )
    THEN
      RAISE EXCEPTION
        'Order unit weight correction must extend the latest exact fact';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_operations_order_unit_weight_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Order unit weight facts are append-only';
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_operations_order_unit_weight_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_global_ids jsonb;
  expected_order_global_id text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.operations_order_unit_weight_facts fact
    WHERE fact.organization_id = OLD.organization_id
      AND fact.command_receipt_id = OLD.id
  ) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Referenced order unit weight receipts cannot be deleted';
  END IF;
  IF OLD.status = 'processing' AND NEW.status = 'succeeded' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.command_type IS DISTINCT FROM OLD.command_type
      OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
      OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
      OR NEW.actor_email IS DISTINCT FROM OLD.actor_email
      OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
      OR NEW.target_global_id IS DISTINCT FROM OLD.target_global_id
      OR NEW.attempts IS DISTINCT FROM OLD.attempts
      OR NEW.started_at IS DISTINCT FROM OLD.started_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'Order unit weight command provenance is immutable';
    END IF;
    SELECT pg_catalog.jsonb_agg(fact.global_id ORDER BY fact.global_id)
      INTO expected_global_ids
    FROM public.operations_order_unit_weight_facts fact
    WHERE fact.organization_id = OLD.organization_id
      AND fact.command_receipt_id = OLD.id;
    SELECT order_row.global_id
      INTO expected_order_global_id
    FROM public.operations_order_unit_weight_facts fact
    JOIN public.operations_orders order_row
      ON order_row.id = fact.order_id
     AND order_row.organization_id = fact.organization_id
    WHERE fact.organization_id = OLD.organization_id
      AND fact.command_receipt_id = OLD.id
    LIMIT 1;
    IF NEW.result_global_id IS DISTINCT FROM OLD.target_global_id
      OR NEW.completed_at IS NULL
      OR NEW.error_code IS NOT NULL
      OR NEW.error_message IS NOT NULL
      OR pg_catalog.jsonb_typeof(NEW.result_payload) IS DISTINCT FROM 'object'
    THEN
      RAISE EXCEPTION 'Order unit weight command result is invalid';
    END IF;
    IF (
        SELECT pg_catalog.array_agg(key ORDER BY key)
        FROM pg_catalog.jsonb_object_keys(NEW.result_payload) field(key)
      ) IS DISTINCT FROM ARRAY[
        'action', 'candidateGlobalId', 'factGlobalIds',
        'orderGlobalId', 'providerWriteCount'
      ]::text[]
      OR NEW.result_payload->>'action'
           IS DISTINCT FROM 'record-order-unit-weights'
      OR NEW.result_payload->>'candidateGlobalId'
           IS DISTINCT FROM OLD.target_global_id
      OR NEW.result_payload->>'orderGlobalId'
           IS DISTINCT FROM expected_order_global_id
      OR pg_catalog.jsonb_typeof(
           NEW.result_payload->'providerWriteCount'
         ) IS DISTINCT FROM 'number'
      OR NEW.result_payload->'providerWriteCount'
           IS DISTINCT FROM '0'::jsonb
      OR pg_catalog.jsonb_typeof(
           NEW.result_payload->'factGlobalIds'
         ) IS DISTINCT FROM 'array'
      OR NEW.result_payload->'factGlobalIds' IS DISTINCT FROM expected_global_ids
    THEN
      RAISE EXCEPTION 'Order unit weight command result is invalid';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Referenced order unit weight receipts are immutable';
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_order_unit_weight_fact
  ON public.operations_order_unit_weight_facts;
CREATE TRIGGER validate_operations_order_unit_weight_fact
BEFORE INSERT ON public.operations_order_unit_weight_facts
FOR EACH ROW EXECUTE FUNCTION public.validate_operations_order_unit_weight_fact();

DROP TRIGGER IF EXISTS protect_operations_order_unit_weight_fact
  ON public.operations_order_unit_weight_facts;
CREATE TRIGGER protect_operations_order_unit_weight_fact
BEFORE UPDATE OR DELETE ON public.operations_order_unit_weight_facts
FOR EACH ROW EXECUTE FUNCTION public.protect_operations_order_unit_weight_fact();

DROP TRIGGER IF EXISTS protect_operations_order_unit_weight_receipt
  ON public.operations_command_receipts;
CREATE TRIGGER protect_operations_order_unit_weight_receipt
BEFORE UPDATE OR DELETE ON public.operations_command_receipts
FOR EACH ROW EXECUTE FUNCTION public.protect_operations_order_unit_weight_receipt();

COMMENT ON TABLE public.operations_order_unit_weight_facts IS
  'Append-only operator unit-weight evidence for one exact imported ordinary-unit planning-line revision. It does not create or imply a Product-pack assignment.';
