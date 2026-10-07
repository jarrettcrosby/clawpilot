-- No credential, grant, source instance or customer mapping is provisioned here.
CREATE TABLE fractional_crm_gateway_credentials (
 id uuid PRIMARY KEY,token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),source_instance_id uuid NOT NULL,
 workspace_organization_id uuid NOT NULL REFERENCES workspace_organizations(id),pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id),
 root_company_global_id text NOT NULL CHECK(root_company_global_id ~ '^ga([0-9]{7}|[0-9a-v]{12})$'),
 allowed_company_global_ids text[] NOT NULL DEFAULT '{}',capabilities text[] NOT NULL DEFAULT '{}',
 fractional_deployment_id uuid NOT NULL,fractional_organization_id text NOT NULL CHECK(length(fractional_organization_id) BETWEEN 1 AND 200),
 actor_email text NOT NULL REFERENCES app_users(email),expires_at timestamptz NOT NULL,revoked_at timestamptz,enabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(capabilities <@ ARRAY['crm.company.read','crm.contact.read','crm.company.write','crm.contact.write','crm.onboarding.write']::text[])
);
CREATE TABLE fractional_crm_gateway_operations (
 id uuid PRIMARY KEY,credential_id uuid NOT NULL REFERENCES fractional_crm_gateway_credentials(id),idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),
 asserted_actor jsonb NOT NULL CHECK(jsonb_typeof(asserted_actor)='object'),origin jsonb CHECK(origin IS NULL OR jsonb_typeof(origin)='object'),
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),operation text NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(credential_id,idempotency_key)
);
COMMENT ON COLUMN fractional_crm_gateway_operations.asserted_actor IS 'Untrusted Fractional caller attribution only; authorization uses the registered credential and live scope.';
CREATE FUNCTION preserve_fractional_crm_credential_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (NEW.id,NEW.token_hash,NEW.source_instance_id,NEW.workspace_organization_id,NEW.pipeline_id,NEW.root_company_global_id,NEW.fractional_deployment_id,NEW.fractional_organization_id,NEW.actor_email,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.token_hash,OLD.source_instance_id,OLD.workspace_organization_id,OLD.pipeline_id,OLD.root_company_global_id,OLD.fractional_deployment_id,OLD.fractional_organization_id,OLD.actor_email,OLD.created_at)
 THEN RAISE EXCEPTION 'Gateway credential identity is immutable; revoke and provision a new credential'; END IF;RETURN NEW;END $$;
CREATE TRIGGER fractional_crm_credential_identity BEFORE UPDATE OR DELETE ON fractional_crm_gateway_credentials FOR EACH ROW EXECUTE FUNCTION preserve_fractional_crm_credential_identity();
CREATE TABLE fractional_crm_source_mappings (
 source_instance_id uuid NOT NULL,workspace_organization_id uuid NOT NULL REFERENCES workspace_organizations(id),pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id),root_company_global_id text NOT NULL,
 fractional_deployment_id uuid NOT NULL,fractional_organization_id text NOT NULL,customer_id text NOT NULL,entity text NOT NULL CHECK(entity IN ('company','contact')),local_id text NOT NULL,
 global_id text NOT NULL,record_id uuid NOT NULL,company_global_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),operation_id uuid NOT NULL REFERENCES fractional_crm_gateway_operations(id) DEFERRABLE INITIALLY DEFERRED,
 PRIMARY KEY(source_instance_id,fractional_deployment_id,fractional_organization_id,customer_id,entity,local_id),
 CHECK((entity='company' AND local_id=customer_id AND global_id=company_global_id AND global_id ~ '^ga([0-9]{7}|[0-9a-v]{12})$') OR (entity='contact' AND global_id ~ '^gc([0-9]{7}|[0-9a-v]{12})$'))
);
-- Accepted verification records are provisioned by a separate administrator
-- workflow. Caller-supplied scheme/value/evidenceId alone never proves identity.
CREATE TABLE fractional_crm_verified_identifiers (
 evidence_id uuid PRIMARY KEY,source_instance_id uuid NOT NULL,workspace_organization_id uuid NOT NULL REFERENCES workspace_organizations(id),pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id),
 scheme text NOT NULL,value text NOT NULL,company_id uuid NOT NULL REFERENCES crm_organizations(id),accepted_by text NOT NULL REFERENCES app_users(email),
 accepted_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz,
 UNIQUE(source_instance_id,workspace_organization_id,pipeline_id,scheme,value)
);
CREATE TABLE fractional_crm_review_decisions (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[0-9a-f]{64}$'),credential_id uuid NOT NULL REFERENCES fractional_crm_gateway_credentials(id),
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),candidate_hash text NOT NULL CHECK(candidate_hash ~ '^[0-9a-f]{64}$'),
 company_global_id text,contact_global_id text,allow_distinct_company boolean NOT NULL DEFAULT false,allow_separate_contact boolean NOT NULL DEFAULT false,
 approved_by text NOT NULL REFERENCES app_users(email),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION preserve_fractional_crm_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fractional CRM gateway evidence is immutable'; END $$;
CREATE TRIGGER fractional_crm_operation_immutable BEFORE UPDATE OR DELETE ON fractional_crm_gateway_operations FOR EACH ROW EXECUTE FUNCTION preserve_fractional_crm_evidence();
CREATE TRIGGER fractional_crm_mapping_immutable BEFORE UPDATE OR DELETE ON fractional_crm_source_mappings FOR EACH ROW EXECUTE FUNCTION preserve_fractional_crm_evidence();
CREATE TRIGGER fractional_crm_review_immutable BEFORE UPDATE OR DELETE ON fractional_crm_review_decisions FOR EACH ROW EXECUTE FUNCTION preserve_fractional_crm_evidence();
