-- Pin the actual local CRM mapping for the lifetime of one admitted private
-- Email recovery. No ordinary publication or unadmitted hold gains a new
-- writer restriction. Native SuiteCRM still verifies its own relationships.
-- The restricted operator cannot read other interactions through RLS. Expose
-- only the unambiguous/not-proven result for an already archived or held
-- Email, never the competing row or its provider identifier.
CREATE FUNCTION clawpilot_crm_legacy_email_provider_identity_unambiguous(p_local uuid,p_pipeline uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE provider_id text;
BEGIN
 IF p_local IS NULL OR p_pipeline IS NULL THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds h
   WHERE h.local_id=p_local AND h.pipeline_id=p_pipeline) THEN
  IF NOT EXISTS(SELECT 1 FROM crm_legacy_email_retirement.retained r
    JOIN crm_legacy_email_retirement.consumed c USING(batch)
    WHERE r.local_id=p_local AND r.pipeline_id=p_pipeline AND r.historical_provider_outcome='unknown') THEN
   RETURN false;
  END IF;
 END IF;
 SELECT NULLIF(lower(btrim(i.provider_message_id)),'') INTO provider_id FROM public.crm_interactions i
  WHERE i.id=p_local AND i.pipeline_id=p_pipeline;
 IF NOT FOUND THEN RETURN false; END IF;
 RETURN provider_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.crm_interactions other
  WHERE other.pipeline_id=p_pipeline AND other.id<>p_local AND lower(btrim(other.provider_message_id))=provider_id);
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_provider_identity_unambiguous(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION clawpilot_crm_legacy_email_live_relationships(p_local uuid,p_pipeline uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 WITH target AS (
   SELECT i.id,i.pipeline_id,i.organization_id,i.contact_id FROM public.crm_interactions i
    WHERE i.id=p_local AND i.pipeline_id=p_pipeline
 ), selected_accounts AS (
   SELECT t.pipeline_id,t.organization_id AS id FROM target t WHERE t.organization_id IS NOT NULL
   UNION
   SELECT l.pipeline_id,l.organization_id FROM target t JOIN public.crm_interaction_organizations l
    ON l.pipeline_id=t.pipeline_id AND l.interaction_id=t.id
 ), selected_contacts AS (
   SELECT l.pipeline_id,l.contact_id AS id FROM target t JOIN public.crm_interaction_contacts l
    ON l.pipeline_id=t.pipeline_id AND l.interaction_id=t.id
 ), designated_primary AS (
   SELECT l.organization_id AS id FROM target t JOIN public.crm_interaction_organizations l
    ON l.pipeline_id=t.pipeline_id AND l.interaction_id=t.id AND l.is_primary
 ), accounts AS (
   SELECT s.id,o.suitecrm_id AS native_id,o.source_payload FROM selected_accounts s
    LEFT JOIN public.crm_organizations o ON o.pipeline_id=s.pipeline_id AND o.id=s.id
 ), contacts AS (
   SELECT c.suitecrm_id AS native_id,c.source_payload,a.native_id AS account_id FROM selected_contacts s
    LEFT JOIN public.crm_contacts c ON c.pipeline_id=s.pipeline_id AND c.id=s.id
    LEFT JOIN accounts a ON a.id=c.organization_id
 )
 -- Unlike an ordinary draft, a privately approved publication must account
 -- for every selected association. An unmapped/archived record, a Contact
 -- outside the selected Accounts, or a missing primary link is not evidence
 -- of an empty projection. Return NULL so the exact controller fails closed.
 SELECT CASE WHEN current_setting('transaction_isolation')='read committed'
   AND public.clawpilot_crm_legacy_email_provider_identity_unambiguous(target.id,target.pipeline_id)
   AND (target.contact_id IS NULL OR EXISTS(SELECT 1 FROM selected_contacts WHERE id=target.contact_id))
   AND ((target.organization_id IS NULL AND NOT EXISTS(SELECT 1 FROM designated_primary))
     OR EXISTS(SELECT 1 FROM designated_primary WHERE id=target.organization_id))
   AND NOT EXISTS(SELECT 1 FROM accounts WHERE (native_id ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,35}$') IS NOT TRUE
     OR COALESCE(lower(source_payload->>'archived'),'false') IN ('true','1','yes'))
   AND NOT EXISTS(SELECT 1 FROM contacts WHERE (native_id ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,35}$') IS NOT TRUE
     OR account_id IS NULL OR COALESCE(lower(source_payload->>'archived'),'false') IN ('true','1','yes'))
 THEN jsonb_build_object(
   'parentType',CASE WHEN target.organization_id IS NULL THEN '' ELSE 'Accounts' END,
   'parentId',COALESCE((SELECT native_id FROM accounts WHERE id=target.organization_id),''),
   'accounts',COALESCE((SELECT jsonb_agg(native_id ORDER BY native_id COLLATE "C") FROM accounts),'[]'::jsonb),
   'contacts',COALESCE((SELECT jsonb_agg(native_id ORDER BY native_id COLLATE "C") FROM contacts),'[]'::jsonb),
   'contactAccounts',COALESCE((SELECT jsonb_agg(jsonb_build_object('contactId',native_id,'accountId',account_id)
     ORDER BY native_id COLLATE "C") FROM contacts),'[]'::jsonb)) ELSE NULL END FROM target
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_live_relationships(uuid,uuid) FROM PUBLIC;

-- 0398 already acquires the publication singleton before row locks on the
-- other source tables. Direct Contact link DML must use that same order.
CREATE FUNCTION clawpilot_crm_legacy_email_contact_link_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE initial_operation text;
BEGIN
 SELECT active_initial_enrollment_id INTO STRICT initial_operation
  FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 IF initial_operation IS NOT NULL THEN
  RAISE EXCEPTION 'Native initial enrollment pins Contact link writers' USING ERRCODE='55000';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_contact_link_lock() FROM PUBLIC;
CREATE TRIGGER crm_legacy_email_contact_link_lock BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
 ON crm_interaction_contacts FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_legacy_email_contact_link_lock();

CREATE FUNCTION clawpilot_crm_legacy_email_relationship_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE active_local uuid; active_pipeline uuid; old_id uuid; new_id uuid;
        old_pipeline uuid; new_pipeline uuid; changed boolean;
BEGIN
 -- TRUNCATE may otherwise run before the alphabetically later 0398 guard.
 -- It is destructive, unlike an unrelated row edit, and cannot bypass an
 -- active release regardless of the old snapshot or table contents.
 IF TG_OP='TRUNCATE' THEN
  PERFORM 1 FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Private Email recovery control missing' USING ERRCODE='55000'; END IF;
 END IF;
 SELECT h.local_id,h.pipeline_id INTO active_local,active_pipeline
  FROM public.crm_native_email_publication_control c
  JOIN public.crm_legacy_email_recovery_releases r ON r.native_operation_id=c.active_operation_id
  JOIN public.crm_legacy_email_recovery_holds h ON h.operation_id=r.hold_id AND h.outbox_id=r.outbox_id
  WHERE c.singleton;
 IF active_local IS NULL THEN
  IF TG_OP='TRUNCATE' THEN RETURN NULL; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='TRUNCATE' THEN
  RAISE EXCEPTION 'Private Email recovery pins relationship tables against truncation' USING ERRCODE='55000';
 END IF;

 changed:=true;
 IF TG_OP<>'INSERT' THEN old_pipeline:=OLD.pipeline_id; END IF;
 IF TG_OP<>'DELETE' THEN new_pipeline:=NEW.pipeline_id; END IF;
 IF TG_TABLE_NAME IN ('crm_interaction_contacts','crm_interaction_organizations') THEN
  IF TG_OP<>'INSERT' THEN old_id:=OLD.interaction_id; END IF;
  IF TG_OP<>'DELETE' THEN new_id:=NEW.interaction_id; END IF;
  IF TG_OP='UPDATE' THEN
   IF TG_TABLE_NAME='crm_interaction_contacts' THEN
    changed:=(OLD.interaction_id,OLD.pipeline_id,OLD.contact_id,OLD.is_primary)
      IS DISTINCT FROM (NEW.interaction_id,NEW.pipeline_id,NEW.contact_id,NEW.is_primary);
   ELSE
    changed:=(OLD.interaction_id,OLD.pipeline_id,OLD.organization_id,OLD.is_primary)
      IS DISTINCT FROM (NEW.interaction_id,NEW.pipeline_id,NEW.organization_id,NEW.is_primary);
   END IF;
  END IF;
  IF changed AND ((old_pipeline=active_pipeline AND old_id=active_local)
       OR (new_pipeline=active_pipeline AND new_id=active_local)) THEN
   RAISE EXCEPTION 'Private Email recovery pins its Account and Contact links' USING ERRCODE='55000';
  END IF;
 ELSE
  IF TG_OP<>'INSERT' THEN old_id:=OLD.id; END IF;
  IF TG_OP<>'DELETE' THEN new_id:=NEW.id; END IF;
  IF TG_OP='UPDATE' THEN
   changed:=(OLD.id,OLD.pipeline_id,OLD.suitecrm_id,
      COALESCE(lower(OLD.source_payload->>'archived'),'false') IN ('true','1','yes'))
     IS DISTINCT FROM (NEW.id,NEW.pipeline_id,NEW.suitecrm_id,
      COALESCE(lower(NEW.source_payload->>'archived'),'false') IN ('true','1','yes'));
   IF TG_TABLE_NAME='crm_contacts' THEN
    changed:=changed OR OLD.organization_id IS DISTINCT FROM NEW.organization_id;
   END IF;
  END IF;
  IF changed AND (old_pipeline=active_pipeline OR new_pipeline=active_pipeline) THEN
   IF TG_TABLE_NAME='crm_contacts' AND EXISTS (
     SELECT 1 FROM public.crm_interaction_contacts l
      WHERE l.pipeline_id=active_pipeline AND l.interaction_id=active_local
       AND ((old_pipeline=active_pipeline AND l.contact_id=old_id)
         OR (new_pipeline=active_pipeline AND l.contact_id=new_id))) THEN
    RAISE EXCEPTION 'Private Email recovery pins its linked Contact mappings' USING ERRCODE='55000';
   ELSIF TG_TABLE_NAME='crm_organizations' AND EXISTS (
     SELECT 1 FROM (
       SELECT i.organization_id AS id FROM public.crm_interactions i
        WHERE i.pipeline_id=active_pipeline AND i.id=active_local
       UNION ALL
       SELECT l.organization_id FROM public.crm_interaction_organizations l
        WHERE l.pipeline_id=active_pipeline AND l.interaction_id=active_local
       UNION ALL
       SELECT c.organization_id FROM public.crm_interaction_contacts l
        JOIN public.crm_contacts c ON c.pipeline_id=l.pipeline_id AND c.id=l.contact_id
        WHERE l.pipeline_id=active_pipeline AND l.interaction_id=active_local
     ) a WHERE (old_pipeline=active_pipeline AND a.id=old_id)
       OR (new_pipeline=active_pipeline AND a.id=new_id)) THEN
    RAISE EXCEPTION 'Private Email recovery pins its linked Account mappings' USING ERRCODE='55000';
   END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_relationship_guard() FROM PUBLIC;
DO $$DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['crm_organizations','crm_contacts','crm_interaction_organizations','crm_interaction_contacts'] LOOP
  EXECUTE format('CREATE TRIGGER crm_legacy_email_relationship_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.clawpilot_crm_legacy_email_relationship_guard()',table_name);
  EXECUTE format('CREATE TRIGGER crm_legacy_email_relationship_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.clawpilot_crm_legacy_email_relationship_guard()',table_name);
 END LOOP;
END $$;

-- This additional deferred edge covers callers admitted to the narrow SQL
-- path, not just the normal TypeScript adapter. Once admitted, the control
-- row revision and row guards protect the mapping through terminal commit.
-- A prior REPEATABLE READ snapshot can otherwise miss an edit that took and
-- released the control lock without modifying its row before admission.
CREATE FUNCTION clawpilot_crm_legacy_email_release_relationships() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE live jsonb; projected jsonb;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
  RAISE EXCEPTION 'Private Email recovery admission requires READ COMMITTED' USING ERRCODE='55000';
 END IF;
 SELECT public.clawpilot_crm_legacy_email_live_relationships(h.local_id,h.pipeline_id),
   jsonb_build_object('parentType',a.command#>'{projection,attributes,parent_type}',
     'parentId',a.command#>'{projection,attributes,parent_id}','accounts',a.command#>'{projection,accounts}',
     'contacts',a.command#>'{projection,contacts}','contactAccounts',a.command#>'{projection,contactAccounts}')
  INTO live,projected FROM public.crm_legacy_email_recovery_holds h
  JOIN public.crm_native_email_publication_admissions a ON a.operation_id=NEW.native_operation_id
  JOIN public.crm_native_email_publication_control c ON c.singleton AND c.active_operation_id=a.operation_id
  WHERE h.operation_id=NEW.hold_id AND h.outbox_id=NEW.outbox_id;
 IF live IS NULL OR live IS DISTINCT FROM projected THEN
  RAISE EXCEPTION 'Private Email recovery admission relationships changed' USING ERRCODE='55000';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_release_relationships() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER crm_legacy_email_release_relationships AFTER INSERT ON crm_legacy_email_recovery_releases
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_legacy_email_release_relationships();
