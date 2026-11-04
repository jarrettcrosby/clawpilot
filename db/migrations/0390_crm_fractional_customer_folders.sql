-- No credentials, mappings, URLs or historical jobs are seeded here.
-- One Account can have one authoritative Fractional customer-folder binding.
CREATE TABLE crm_fractional_customer_folders (
 account_id uuid PRIMARY KEY REFERENCES crm_organizations(id) ON DELETE RESTRICT,
 source_instance_id uuid NOT NULL,
 fractional_deployment_id uuid NOT NULL,
 fractional_organization_id text NOT NULL,
 customer_id text NOT NULL,
 entity text NOT NULL DEFAULT 'company' CHECK(entity='company'),
 local_id text NOT NULL CHECK(local_id=customer_id),
 last_published_url text CHECK(last_published_url IS NULL OR
   (length(last_published_url) BETWEEN 9 AND 2048 AND last_published_url LIKE 'https://%')),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(source_instance_id,fractional_deployment_id,fractional_organization_id,customer_id,entity,local_id)
  REFERENCES fractional_crm_source_mappings(source_instance_id,fractional_deployment_id,fractional_organization_id,customer_id,entity,local_id)
  ON DELETE RESTRICT
);
CREATE FUNCTION preserve_crm_fractional_customer_folder_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.account_id,NEW.source_instance_id,NEW.fractional_deployment_id,
  NEW.fractional_organization_id,NEW.customer_id,NEW.entity,NEW.local_id)
 IS DISTINCT FROM (OLD.account_id,OLD.source_instance_id,OLD.fractional_deployment_id,
  OLD.fractional_organization_id,OLD.customer_id,OLD.entity,OLD.local_id)
 THEN RAISE EXCEPTION 'Fractional customer folder identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_fractional_customer_folder_identity BEFORE UPDATE OR DELETE ON crm_fractional_customer_folders
 FOR EACH ROW EXECUTE FUNCTION preserve_crm_fractional_customer_folder_identity();
