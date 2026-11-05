-- Distinguish a first mapped-user access grant from restoration of a recorded
-- revocation. No activation, historical rewrite, identity enrollment or native
-- permission mutation. Existing native-first app-commit guards remain intact.
CREATE FUNCTION clawpilot_native_email_user_is_eligible(user_row jsonb, membership_row jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
  SELECT (user_row->>'status'='active' AND membership_row->>'status'='active'
    AND membership_row->'trashed_at'='null'::jsonb
    AND (membership_row->>'role'='owner'
      OR COALESCE(membership_row->'permissions'->>'viewCrm','true')='true')) IS TRUE;
$$;

CREATE FUNCTION clawpilot_native_email_user_grant_lineage_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE desired jsonb:=NEW.plan->'desiredAppChange'; latest record; expected jsonb:='null'::jsonb;
  u_before jsonb; u_after jsonb; m_before jsonb; m_after jsonb;
BEGIN
  IF desired->>'kind' IS DISTINCT FROM 'workspace_user_eligibility_v1' THEN RETURN NEW; END IF;
  -- Use the same canonical validator and control-first serialization as the
  -- existing transition path, including when a direct insert omits the adapter.
  PERFORM singleton FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Native user grant control missing' USING ERRCODE='55000'; END IF;
  PERFORM * FROM public.clawpilot_native_email_user_change_rows(desired);
  u_before:=(desired->'appUser'->>'beforeJson')::jsonb;
  u_after:=(desired->'appUser'->>'afterJson')::jsonb;
  m_before:=(desired->'membership'->>'beforeJson')::jsonb;
  m_after:=(desired->'membership'->>'afterJson')::jsonb;
  IF NOT public.clawpilot_native_email_user_is_eligible(u_before,m_before)
    AND public.clawpilot_native_email_user_is_eligible(u_after,m_after) THEN
    SELECT prior.transition_id,prior.plan_hash INTO latest
    FROM public.crm_native_email_authority_transitions prior
    WHERE prior.app_state='committed'
      AND prior.plan->'desiredAppChange'->>'kind'='workspace_user_eligibility_v1'
      AND prior.plan->'desiredAppChange'->>'userEmail'=desired->>'userEmail'
      AND prior.plan->'desiredAppChange'->>'workspaceId'=desired->>'workspaceId'
      AND public.clawpilot_native_email_user_is_eligible(
        (prior.plan->'desiredAppChange'->'appUser'->>'beforeJson')::jsonb,
        (prior.plan->'desiredAppChange'->'membership'->>'beforeJson')::jsonb)
      AND NOT public.clawpilot_native_email_user_is_eligible(
        (prior.plan->'desiredAppChange'->'appUser'->>'afterJson')::jsonb,
        (prior.plan->'desiredAppChange'->'membership'->>'afterJson')::jsonb)
    ORDER BY (prior.plan->'revoke'->>'generationFrom')::bigint DESC,prior.created_at DESC,prior.transition_id DESC LIMIT 1;
    IF FOUND THEN expected:=jsonb_build_object('transitionId',latest.transition_id,'planHash',latest.plan_hash); END IF;
  END IF;
  IF desired->'restoreFrom' IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Native user grant requires exact latest revocation lineage or a verified first grant'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER crm_native_email_user_grant_lineage_guard BEFORE INSERT
  ON crm_native_email_authority_transitions FOR EACH ROW
  EXECUTE FUNCTION clawpilot_native_email_user_grant_lineage_guard();
