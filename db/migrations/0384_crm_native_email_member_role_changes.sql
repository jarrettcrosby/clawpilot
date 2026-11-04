-- Retained viewer/editor changes use the existing native-revoke -> exact app
-- commit -> native-grant protocol. No activation, identity enrollment, owner
-- changes, or remove/re-add workaround. Earlier migration bytes remain pinned.
ALTER TABLE crm_native_email_authority_member_changes
  DROP CONSTRAINT crm_native_email_authority_member_changes_check;

ALTER TABLE crm_native_email_authority_member_changes
  ADD CONSTRAINT crm_native_authority_member_delta_check CHECK ((
    ((before_row IS NULL)<>(after_row IS NULL)) OR
    (before_row IS NOT NULL AND after_row IS NOT NULL
      AND jsonb_typeof(before_row)='object' AND jsonb_typeof(after_row)='object'
      AND before_row ?& ARRAY['pipeline_id','user_email','access_role','shared_by','created_at','updated_at']
      AND after_row ?& ARRAY['pipeline_id','user_email','access_role','shared_by','created_at','updated_at']
      AND (before_row-ARRAY['pipeline_id','user_email','access_role','shared_by','created_at','updated_at'])='{}'::jsonb
      AND (after_row-ARRAY['pipeline_id','user_email','access_role','shared_by','created_at','updated_at'])='{}'::jsonb
      AND (before_row-ARRAY['access_role','updated_at'])=(after_row-ARRAY['access_role','updated_at'])
      AND before_row->>'access_role' IN ('viewer','editor')
      AND after_row->>'access_role' IN ('viewer','editor')
      AND before_row->>'access_role'<>after_row->>'access_role'
      AND jsonb_typeof(before_row->'updated_at')='string'
      AND jsonb_typeof(after_row->'updated_at')='string'
      AND (after_row->>'updated_at')::timestamptz >= (before_row->>'updated_at')::timestamptz)
  ) IS TRUE);

COMMENT ON CONSTRAINT crm_native_authority_member_delta_check ON crm_native_email_authority_member_changes IS
  'Exact add/remove or retained viewer/editor delta; ledger preimages, native receipt ordering, and immutable identity remain mandatory.';

-- The metadata snapshot guard must admit the same complete role preimage as
-- the authority row guard, in the exact native-revoked app transaction only.
-- Preserve the newer user-eligibility ancestry/demo protections as well.
CREATE OR REPLACE FUNCTION clawpilot_native_email_transition_snapshot_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE plan jsonb; desired jsonb; old_row jsonb:=to_jsonb(OLD);
  new_row jsonb:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END; affected boolean;
BEGIN
  SELECT t.plan INTO plan FROM public.crm_native_email_publication_control c
    JOIN public.crm_native_email_authority_transitions t ON t.transition_id=c.active_transition_id WHERE c.singleton;
  IF plan IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
  desired:=plan->'desiredAppChange';
  IF TG_TABLE_NAME='pipeline_space_members' AND TG_OP='UPDATE' AND EXISTS(
    SELECT 1 FROM public.crm_native_email_publication_control c
    JOIN public.crm_native_email_authority_transitions t ON t.transition_id=c.active_transition_id
    JOIN public.crm_native_email_authority_phases p ON p.transition_id=t.transition_id AND p.phase='revoke'
    JOIN public.crm_native_email_authority_member_changes d ON d.transition_id=t.transition_id
    WHERE c.singleton AND c.enabled AND c.active_operation_id IS NULL AND t.app_state='applying'
      AND t.applying_xid=txid_current() AND p.state='committed'
      AND desired->>'kind'='pipeline_members_v1' AND d.before_row=old_row AND d.after_row=new_row
      AND old_row->>'access_role'<>new_row->>'access_role') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='pipeline_space_members' THEN
    affected:=old_row IS DISTINCT FROM new_row AND EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'revoke'->'bindings') b
      WHERE b->'before'->>'pipeline_id'=OLD.pipeline_id::text OR b->'before'->>'pipeline_id'=NEW.pipeline_id::text);
  ELSIF TG_TABLE_NAME='workspace_organizations' THEN
    affected:=(old_row->'id',old_row->'is_demo') IS DISTINCT FROM (new_row->'id',new_row->'is_demo')
      AND (EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'revoke'->'bindings') b
        WHERE b->'before'->>'workspace_id'=old_row->>'id' OR b->'before'->>'workspace_id'=new_row->>'id')
      OR (desired->>'kind'='workspace_user_eligibility_v1' AND (
        desired->>'workspaceId' IN (old_row->>'id',new_row->>'id')
        OR EXISTS(SELECT 1 FROM public.app_user_organization_memberships m
          WHERE m.user_email=desired->>'userEmail' AND m.organization_id::text IN (old_row->>'id',new_row->>'id'))
        OR ((desired->'demoMembership'->>'beforeJson')::jsonb)->>'organization_id' IN (old_row->>'id',new_row->>'id'))));
    affected:=affected OR (desired->>'kind'='workspace_user_eligibility_v1'
      AND (old_row->'id',old_row->'parent_id',old_row->'is_demo') IS DISTINCT FROM
        (new_row->'id',new_row->'parent_id',new_row->'is_demo')
      AND EXISTS(SELECT 1 FROM jsonb_array_elements((desired->'actorScope'->>'ancestryJson')::jsonb) path
        WHERE path->>'id' IN (old_row->>'id',new_row->>'id')));
  ELSE RAISE EXCEPTION 'Unknown native snapshot source' USING ERRCODE='55000'; END IF;
  IF affected THEN RAISE EXCEPTION 'Native authority snapshot is pinned during transition' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
