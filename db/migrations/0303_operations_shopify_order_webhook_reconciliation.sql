-- Durable, owner-authorized reconciliation of the seven minimized Shopify
-- order-signal webhooks. Provider attempts are committed before dispatch and
-- outcomes are append-only. No delete authority is represented by this schema.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.operations_shopify_order_webhook_plan_is_valid(
  candidate jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT
    jsonb_typeof(candidate) = 'array'
    AND jsonb_array_length(candidate) <= 7
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(candidate) item
      WHERE jsonb_typeof(item) <> 'object'
         OR NOT item ?& ARRAY['topic', 'action', 'providerId']
         OR EXISTS (
           SELECT 1
           FROM jsonb_object_keys(item) key
           WHERE key NOT IN ('topic', 'action', 'providerId')
         )
         OR item->>'topic' NOT IN (
           'orders/create',
           'orders/updated',
           'orders/edited',
           'orders/cancelled',
           'orders/paid',
           'orders/fulfilled',
           'orders/partially_fulfilled'
         )
         OR item->>'action' NOT IN ('create', 'update')
         OR (
           item->>'action' = 'create'
           AND item->'providerId' <> 'null'::jsonb
         )
         OR (
           item->>'action' = 'update'
           AND COALESCE(item->>'providerId', '') !~
             '^gid://shopify/WebhookSubscription/[1-9][0-9]*$'
         )
    )
    AND (
      SELECT count(*) = count(DISTINCT item->>'topic')
      FROM jsonb_array_elements(candidate) item
    );
$$;

CREATE TABLE IF NOT EXISTS public.operations_shopify_order_webhook_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  integration_account_global_id text NOT NULL,
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  external_account_id text NOT NULL,
  shop_domain text NOT NULL,
  callback_uri text NOT NULL,
  desired_topics text[] NOT NULL,
  include_fields text[] NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  confirmation_hash text NOT NULL
    CHECK (confirmation_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'prepared' CHECK (
    status IN (
      'prepared', 'processing', 'recoverable', 'succeeded', 'failed',
      'unknown', 'reconciled'
    )
  ),
  authorized_by text NOT NULL REFERENCES public.app_users(email) ON DELETE RESTRICT,
  authorized_role text NOT NULL CHECK (authorized_role IN ('owner', 'admin')),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processing_at timestamptz,
  processing_lease_expires_at timestamptz,
  completed_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_shopify_order_webhook_command_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES public.operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_webhook_command_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT ops_shopify_order_webhook_command_idempotency_unique
    UNIQUE (organization_id, integration_account_id, idempotency_key),
  CONSTRAINT ops_shopify_order_webhook_command_identity_valid CHECK (
    integration_account_global_id ~ '^gia(?:[0-9]{7}|[0-9a-v]{12})$'
    AND external_account_id ~ '^gid://shopify/Shop/[1-9][0-9]{0,20}$'
    AND shop_domain = lower(shop_domain)
    AND shop_domain ~
      '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$'
    AND callback_uri ~ '^https://[^/?#]+/api/integrations/commerce/shopify/webhooks/gia(?:[0-9]{7}|[0-9a-v]{12})$'
    AND right(callback_uri, length(integration_account_global_id)) =
      integration_account_global_id
  ),
  CONSTRAINT ops_shopify_order_webhook_command_profile_valid CHECK (
    desired_topics = ARRAY[
      'orders/create',
      'orders/updated',
      'orders/edited',
      'orders/cancelled',
      'orders/paid',
      'orders/fulfilled',
      'orders/partially_fulfilled'
    ]::text[]
    AND include_fields = ARRAY[
      'admin_graphql_api_id', 'updated_at'
    ]::text[]
  ),
  CONSTRAINT ops_shopify_order_webhook_command_text_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
    AND (error_code IS NULL OR (
      error_code ~ '^[A-Z][A-Z0-9_]{2,127}$'
    ))
  ),
  CONSTRAINT ops_shopify_order_webhook_command_state_valid CHECK (
    (
      status = 'prepared'
      AND processing_at IS NULL
      AND processing_lease_expires_at IS NULL
      AND completed_at IS NULL
      AND error_code IS NULL
    ) OR (
      status = 'processing'
      AND processing_at IS NOT NULL
      AND processing_lease_expires_at = processing_at + interval '2 minutes'
      AND completed_at IS NULL
      AND error_code IS NULL
    ) OR (
      status IN ('succeeded', 'reconciled')
      AND processing_at IS NOT NULL
      AND processing_lease_expires_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND completed_at >= processing_at
      AND error_code IS NULL
    ) OR (
      status = 'recoverable'
      AND processing_at IS NOT NULL
      AND processing_lease_expires_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND completed_at >= processing_at
      AND error_code IS NOT NULL
    ) OR (
      status = 'unknown'
      AND processing_at IS NOT NULL
      AND processing_lease_expires_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND completed_at >= processing_at
      AND error_code IS NOT NULL
    ) OR (
      status = 'failed'
      AND completed_at IS NOT NULL
      AND error_code IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ops_shopify_order_webhook_one_open_idx
  ON public.operations_shopify_order_webhook_commands (
    organization_id, integration_account_id
  )
  WHERE status IN ('prepared', 'processing', 'recoverable', 'unknown');

CREATE INDEX IF NOT EXISTS ops_shopify_order_webhook_command_recent_idx
  ON public.operations_shopify_order_webhook_commands (
    organization_id, prepared_at DESC, id DESC
  );

CREATE TABLE IF NOT EXISTS public.operations_shopify_order_webhook_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.workspace_organizations(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  external_account_id text NOT NULL,
  shop_domain text NOT NULL,
  callback_uri text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 32),
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  mutation_plan jsonb NOT NULL CHECK (
    public.operations_shopify_order_webhook_plan_is_valid(mutation_plan)
  ),
  dispatch_state text NOT NULL DEFAULT 'authorized'
    CHECK (dispatch_state = 'authorized'),
  claimed_by text NOT NULL REFERENCES public.app_users(email) ON DELETE RESTRICT,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_shopify_order_webhook_attempt_command_fkey
    FOREIGN KEY (organization_id, command_id)
    REFERENCES public.operations_shopify_order_webhook_commands(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_webhook_attempt_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES public.operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_webhook_attempt_number_unique
    UNIQUE (organization_id, command_id, attempt_number),
  CONSTRAINT ops_shopify_order_webhook_attempt_identity_valid CHECK (
    external_account_id ~ '^gid://shopify/Shop/[1-9][0-9]{0,20}$'
    AND shop_domain ~
      '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$'
    AND callback_uri ~ '^https://[^/?#]+/api/integrations/commerce/shopify/webhooks/gia(?:[0-9]{7}|[0-9a-v]{12})$'
  )
);

ALTER TABLE public.operations_shopify_order_webhook_attempts
  ADD CONSTRAINT ops_shopify_order_webhook_attempt_org_id_unique
  UNIQUE (organization_id, id);

CREATE OR REPLACE FUNCTION public.operations_shopify_order_webhook_refs_are_valid(
  candidate text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT cardinality(candidate) <= 7
    AND NOT EXISTS (
      SELECT 1 FROM unnest(candidate) reference
      WHERE reference !~
        '^gid://shopify/WebhookSubscription/[1-9][0-9]*$'
    );
$$;

CREATE OR REPLACE FUNCTION public.operations_shopify_order_webhook_completions_are_valid(
  candidate jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT
    jsonb_typeof(candidate) = 'array'
    AND jsonb_array_length(candidate) <= 7
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(candidate) item
      WHERE jsonb_typeof(item) <> 'object'
         OR NOT item ?& ARRAY['topic', 'action', 'providerId']
         OR EXISTS (
           SELECT 1
           FROM jsonb_object_keys(item) key
           WHERE key NOT IN ('topic', 'action', 'providerId')
         )
         OR item->>'topic' NOT IN (
           'orders/create',
           'orders/updated',
           'orders/edited',
           'orders/cancelled',
           'orders/paid',
           'orders/fulfilled',
           'orders/partially_fulfilled'
         )
         OR item->>'action' NOT IN ('create', 'update')
         OR COALESCE(item->>'providerId', '') !~
           '^gid://shopify/WebhookSubscription/[1-9][0-9]*$'
    )
    AND (
      SELECT count(*) = count(DISTINCT item->>'topic')
      FROM jsonb_array_elements(candidate) item
    );
$$;

CREATE TABLE IF NOT EXISTS public.operations_shopify_order_webhook_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.workspace_organizations(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  provider_attempt_id uuid NOT NULL,
  outcome_state text NOT NULL CHECK (
    outcome_state IN (
      'recoverable', 'succeeded', 'failed', 'unknown', 'reconciled'
    )
  ),
  provider_write_count integer CHECK (
    provider_write_count IS NULL OR provider_write_count BETWEEN 0 AND 7
  ),
  provider_references text[] NOT NULL DEFAULT '{}'::text[],
  completed_mutations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    public.operations_shopify_order_webhook_completions_are_valid(
      completed_mutations
    )
  ),
  stopped_mutation jsonb CHECK (
    stopped_mutation IS NULL
    OR public.operations_shopify_order_webhook_plan_is_valid(
      jsonb_build_array(stopped_mutation)
    )
  ),
  stop_classification text CHECK (
    stop_classification IS NULL
    OR stop_classification IN ('deterministic_rejection', 'ambiguous')
  ),
  result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  error_code text,
  completed_by text NOT NULL REFERENCES public.app_users(email) ON DELETE RESTRICT,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_shopify_order_webhook_outcome_command_fkey
    FOREIGN KEY (organization_id, command_id)
    REFERENCES public.operations_shopify_order_webhook_commands(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_webhook_outcome_attempt_fkey
    FOREIGN KEY (organization_id, provider_attempt_id)
    REFERENCES public.operations_shopify_order_webhook_attempts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_webhook_outcome_attempt_state_unique
    UNIQUE (organization_id, provider_attempt_id, outcome_state),
  CONSTRAINT ops_shopify_order_webhook_outcome_state_valid CHECK (
    (
      outcome_state = 'succeeded'
      AND provider_write_count = jsonb_array_length(completed_mutations)
      AND error_code IS NULL
      AND stopped_mutation IS NULL
      AND stop_classification IS NULL
    ) OR (
      outcome_state = 'reconciled'
      AND provider_write_count = 0
      AND completed_mutations = '[]'::jsonb
      AND error_code IS NULL
      AND stopped_mutation IS NULL
      AND stop_classification IS NULL
    ) OR (
      outcome_state = 'failed'
      AND provider_write_count = jsonb_array_length(completed_mutations)
      AND error_code IS NOT NULL
      AND stopped_mutation IS NULL
      AND stop_classification IS NULL
    ) OR (
      outcome_state = 'recoverable'
      AND provider_write_count = jsonb_array_length(completed_mutations)
      AND error_code IS NOT NULL
      AND stopped_mutation IS NOT NULL
      AND stop_classification = 'deterministic_rejection'
    ) OR (
      outcome_state = 'unknown'
      AND provider_write_count IS NULL
      AND error_code IS NOT NULL
      AND stop_classification = 'ambiguous'
    )
  ),
  CONSTRAINT ops_shopify_order_webhook_outcome_references_valid CHECK (
    public.operations_shopify_order_webhook_refs_are_valid(provider_references)
    AND cardinality(provider_references) =
      jsonb_array_length(completed_mutations)
  )
);

CREATE OR REPLACE FUNCTION public.protect_shopify_order_webhook_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  binding_count integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT count(*) INTO binding_count
    FROM public.operations_integration_accounts account
    JOIN public.operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN public.app_user_organization_memberships membership
      ON membership.organization_id = account.organization_id
     AND membership.user_email = NEW.authorized_by
     AND membership.status = 'active'
     AND membership.role = NEW.authorized_role
     AND membership.role IN ('owner', 'admin')
    WHERE account.organization_id = NEW.organization_id
      AND account.id = NEW.integration_account_id
      AND account.global_id = NEW.integration_account_global_id
      AND account.integration_type = 'commerce'
      AND account.provider = 'shopify'
      AND account.status = 'active'
      AND account.external_account_id = NEW.external_account_id
      AND account.commerce_credential_generation = NEW.credential_generation
      AND credential.external_account_id = NEW.external_account_id
      AND credential.credential_version = NEW.credential_generation
      AND credential.verification_status = 'verified'
      AND account.configuration->>'shopDomain' = NEW.shop_domain;
    IF binding_count <> 1 THEN
      RAISE EXCEPTION 'Shopify order webhook command binding is not current';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.organization_id, NEW.integration_account_id,
    NEW.integration_account_global_id, NEW.credential_generation,
    NEW.external_account_id, NEW.shop_domain, NEW.callback_uri,
    NEW.desired_topics, NEW.include_fields, NEW.idempotency_key,
    NEW.request_hash, NEW.confirmation_hash, NEW.authorized_by,
    NEW.authorized_role, NEW.prepared_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organization_id, OLD.integration_account_id,
    OLD.integration_account_global_id, OLD.credential_generation,
    OLD.external_account_id, OLD.shop_domain, OLD.callback_uri,
    OLD.desired_topics, OLD.include_fields, OLD.idempotency_key,
    OLD.request_hash, OLD.confirmation_hash, OLD.authorized_by,
    OLD.authorized_role, OLD.prepared_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Shopify order webhook command identity is immutable';
  END IF;
  IF NOT (
    (OLD.status = 'prepared' AND NEW.status IN ('processing', 'failed'))
    OR (OLD.status = 'processing' AND NEW.status IN (
      'recoverable', 'succeeded', 'failed', 'unknown'
    ))
    OR (OLD.status IN ('recoverable', 'unknown') AND NEW.status = 'processing')
    OR (OLD.status IN ('recoverable', 'unknown') AND NEW.status = 'reconciled')
    OR (OLD.status = 'recoverable' AND NEW.status = 'failed')
  ) THEN
    RAISE EXCEPTION 'Shopify order webhook command transition is invalid';
  END IF;
  IF NEW.updated_at < OLD.updated_at
     OR NEW.updated_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Shopify order webhook command audit time is invalid';
  END IF;
  IF OLD.status = 'prepared' AND NEW.status = 'processing' AND (
    NEW.processing_at < OLD.prepared_at
    OR NEW.processing_at > clock_timestamp() + interval '5 minutes'
  ) THEN
    RAISE EXCEPTION 'Shopify order webhook processing evidence is invalid';
  END IF;
  IF OLD.status = 'prepared' AND NEW.status = 'failed' AND (
    NEW.processing_at IS NOT NULL
    OR NEW.processing_lease_expires_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Shopify order webhook pre-dispatch failure is invalid';
  END IF;
  IF OLD.status = 'processing' AND ROW(
    NEW.processing_at, NEW.processing_lease_expires_at
  ) IS DISTINCT FROM ROW(
    OLD.processing_at, OLD.processing_lease_expires_at
  ) THEN
    RAISE EXCEPTION 'Shopify order webhook dispatch evidence is immutable';
  END IF;
  IF OLD.status IN ('recoverable', 'unknown')
     AND NEW.status = 'reconciled'
     AND ROW(
       NEW.processing_at, NEW.processing_lease_expires_at
     ) IS DISTINCT FROM ROW(
       OLD.processing_at, OLD.processing_lease_expires_at
     ) THEN
    RAISE EXCEPTION 'Shopify order webhook recovery evidence is immutable';
  END IF;
  IF NEW.status IN (
    'recoverable', 'succeeded', 'failed', 'unknown', 'reconciled'
  ) AND (
    NEW.completed_at < OLD.updated_at
    OR NEW.completed_at > clock_timestamp() + interval '5 minutes'
  ) THEN
    RAISE EXCEPTION 'Shopify order webhook completion evidence is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_webhook_command_write
  ON public.operations_shopify_order_webhook_commands;
CREATE TRIGGER protect_shopify_order_webhook_command_write
BEFORE INSERT OR UPDATE ON public.operations_shopify_order_webhook_commands
FOR EACH ROW EXECUTE FUNCTION public.protect_shopify_order_webhook_command();

CREATE OR REPLACE FUNCTION public.protect_shopify_order_webhook_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  command_count integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Shopify order webhook attempts are immutable';
  END IF;
  SELECT count(*) INTO command_count
  FROM public.operations_shopify_order_webhook_commands command
  JOIN public.operations_integration_accounts account
    ON account.organization_id = command.organization_id
   AND account.id = command.integration_account_id
  JOIN public.operations_commerce_credentials credential
    ON credential.organization_id = account.organization_id
   AND credential.integration_account_id = account.id
  JOIN public.app_user_organization_memberships membership
    ON membership.organization_id = command.organization_id
   AND membership.user_email = NEW.claimed_by
   AND membership.status = 'active'
   AND membership.role IN ('owner', 'admin')
  WHERE command.organization_id = NEW.organization_id
    AND command.id = NEW.command_id
    AND command.status IN ('prepared', 'recoverable')
    AND command.integration_account_id = NEW.integration_account_id
    AND command.credential_generation = NEW.credential_generation
    AND command.external_account_id = NEW.external_account_id
    AND command.shop_domain = NEW.shop_domain
    AND command.callback_uri = NEW.callback_uri
    AND command.request_hash = NEW.request_hash
    AND NEW.attempt_number = (
      SELECT count(*) + 1
      FROM public.operations_shopify_order_webhook_attempts existing
      WHERE existing.organization_id = NEW.organization_id
        AND existing.command_id = NEW.command_id
    )
    AND account.status = 'active'
    AND account.external_account_id = NEW.external_account_id
    AND account.commerce_credential_generation = NEW.credential_generation
    AND account.configuration->>'shopDomain' = NEW.shop_domain
    AND credential.external_account_id = NEW.external_account_id
    AND credential.credential_version = NEW.credential_generation
    AND credential.verification_status = 'verified';
  IF command_count <> 1 THEN
    RAISE EXCEPTION 'Shopify order webhook provider attempt lost authority';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_webhook_attempt_write
  ON public.operations_shopify_order_webhook_attempts;
CREATE TRIGGER protect_shopify_order_webhook_attempt_write
BEFORE INSERT OR UPDATE OR DELETE ON public.operations_shopify_order_webhook_attempts
FOR EACH ROW EXECUTE FUNCTION public.protect_shopify_order_webhook_attempt();

CREATE OR REPLACE FUNCTION public.protect_shopify_order_webhook_outcome()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_count integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Shopify order webhook outcomes are immutable';
  END IF;
  SELECT count(*) INTO linked_count
  FROM public.operations_shopify_order_webhook_commands command
  JOIN public.operations_shopify_order_webhook_attempts attempt
    ON attempt.organization_id = command.organization_id
   AND attempt.command_id = command.id
  WHERE command.organization_id = NEW.organization_id
    AND command.id = NEW.command_id
    AND attempt.id = NEW.provider_attempt_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.operations_shopify_order_webhook_attempts later
      WHERE later.organization_id = attempt.organization_id
        AND later.command_id = attempt.command_id
        AND later.attempt_number > attempt.attempt_number
    )
    AND (
      (command.status = 'processing' AND NEW.outcome_state IN (
        'recoverable', 'succeeded', 'failed', 'unknown'
      ))
      OR (command.status IN ('recoverable', 'unknown')
          AND NEW.outcome_state = 'reconciled')
    );
  IF NOT EXISTS (
    SELECT 1
    FROM public.app_user_organization_memberships membership
    WHERE membership.organization_id = NEW.organization_id
      AND membership.user_email = NEW.completed_by
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Shopify order webhook outcome lost current authority';
  END IF;
  IF linked_count <> 1 THEN
    RAISE EXCEPTION 'Shopify order webhook outcome is not linked to authority';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_webhook_outcome_write
  ON public.operations_shopify_order_webhook_outcomes;
CREATE TRIGGER protect_shopify_order_webhook_outcome_write
BEFORE INSERT OR UPDATE OR DELETE ON public.operations_shopify_order_webhook_outcomes
FOR EACH ROW EXECUTE FUNCTION public.protect_shopify_order_webhook_outcome();

CREATE OR REPLACE FUNCTION public.protect_shopify_order_webhook_binding_drift()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.operations_shopify_order_webhook_commands command
    WHERE command.organization_id = OLD.organization_id
      AND command.integration_account_id = OLD.id
      AND command.status IN ('prepared', 'processing', 'recoverable', 'unknown')
  ) AND ROW(
    NEW.id, NEW.organization_id, NEW.global_id,
    NEW.integration_type, NEW.provider,
    NEW.status, NEW.external_account_id,
    NEW.commerce_credential_generation,
    NEW.configuration->>'shopDomain'
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.organization_id, OLD.global_id,
    OLD.integration_type, OLD.provider,
    OLD.status, OLD.external_account_id,
    OLD.commerce_credential_generation,
    OLD.configuration->>'shopDomain'
  ) THEN
    RAISE EXCEPTION 'Shopify order webhook dispatch binding cannot drift';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_webhook_account_drift
  ON public.operations_integration_accounts;
CREATE TRIGGER protect_shopify_order_webhook_account_drift
BEFORE UPDATE ON public.operations_integration_accounts
FOR EACH ROW EXECUTE FUNCTION public.protect_shopify_order_webhook_binding_drift();

CREATE OR REPLACE FUNCTION public.protect_shopify_order_webhook_credential_drift()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.operations_shopify_order_webhook_commands command
    WHERE command.organization_id = OLD.organization_id
      AND command.integration_account_id = OLD.integration_account_id
      AND command.status IN ('prepared', 'processing', 'recoverable', 'unknown')
  ) AND (TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Shopify order webhook credential cannot rotate during dispatch';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_webhook_credential_drift
  ON public.operations_commerce_credentials;
CREATE TRIGGER protect_shopify_order_webhook_credential_drift
BEFORE UPDATE OR DELETE ON public.operations_commerce_credentials
FOR EACH ROW EXECUTE FUNCTION public.protect_shopify_order_webhook_credential_drift();

CREATE OR REPLACE FUNCTION public.protect_shopify_order_webhook_membership_drift()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.operations_shopify_order_webhook_commands command
    WHERE command.organization_id = OLD.organization_id
      AND command.authorized_by = OLD.user_email
      AND command.status IN ('prepared', 'processing', 'recoverable', 'unknown')
  ) AND (
    TG_OP = 'DELETE'
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.user_email IS DISTINCT FROM OLD.user_email
    OR NEW.status <> 'active'
    OR NEW.role NOT IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Shopify order webhook command author cannot lose authority while recovery is open';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_webhook_membership_drift
  ON public.app_user_organization_memberships;
CREATE TRIGGER protect_shopify_order_webhook_membership_drift
BEFORE UPDATE OR DELETE ON public.app_user_organization_memberships
FOR EACH ROW EXECUTE FUNCTION public.protect_shopify_order_webhook_membership_drift();

COMMENT ON TABLE public.operations_shopify_order_webhook_commands IS
  'Durable idempotent owner/admin receipts for exact seven-topic Shopify order webhook reconciliation.';
COMMENT ON TABLE public.operations_shopify_order_webhook_attempts IS
  'Immutable initial and deterministic-residual provider mutation plans committed before Shopify dispatch; no delete action is representable.';
COMMENT ON TABLE public.operations_shopify_order_webhook_outcomes IS
  'Append-only provider outcomes with completed mutation references and deterministic versus ambiguous stop classification.';
