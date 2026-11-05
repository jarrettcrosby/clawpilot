-- A retained, deliberately unenrolled app pipeline is not a native Email
-- binding. Never infer that from an empty current policy table alone.
-- Initial selection is pure; active app mutations additionally require the
-- real retained initial enrollment, exact omission and idle authority control.
DO $$ BEGIN
 IF (SELECT encode(public.digest(prosrc,'sha256'),'hex') FROM pg_proc
   WHERE oid='public.clawpilot_native_email_app_only_change_is_independent(text,jsonb,jsonb)'::regprocedure)
   IS DISTINCT FROM '5ba06eacd5fc5dfc5c87343812c023d4c634d41c11c8b8cb804f22c84c0cbf2e' THEN
  RAISE EXCEPTION 'Reviewed app-only source classifier differs' USING ERRCODE='55000';
 END IF;
END $$;

-- Call only on actual native command/policy scopes, never whole source
-- snapshots (which intentionally inventory every app pipeline).
CREATE FUNCTION clawpilot_crm_native_json_has_pipeline(value jsonb,pipeline uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT COALESCE(jsonb_path_exists(value,
   'lax $.** ? (@.pipelineId == $id || @.pipeline_id == $id || @.intake_pipeline_id == $id || @.intakePipelineId == $id)',
   jsonb_build_object('id',pipeline::text)),false)
$$;

-- Exact current aggregate ownership lets unrelated ordinary queued work stay
-- queued; unknown, orphaned and contradictory native intent never qualifies.
CREATE FUNCTION clawpilot_crm_native_outbox_pipeline(aggregate_type text,aggregate_id text)
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE result uuid;
BEGIN
 CASE aggregate_type
  WHEN 'crm_interactions' THEN SELECT pipeline_id INTO result FROM public.crm_interactions WHERE id::text=aggregate_id;
  WHEN 'crm_organizations' THEN SELECT pipeline_id INTO result FROM public.crm_organizations WHERE id::text=aggregate_id;
  WHEN 'crm_contacts' THEN SELECT pipeline_id INTO result FROM public.crm_contacts WHERE id::text=aggregate_id;
  WHEN 'crm_leads' THEN SELECT pipeline_id INTO result FROM public.crm_leads WHERE id::text=aggregate_id;
  WHEN 'crm_opportunities' THEN SELECT pipeline_id INTO result FROM public.crm_opportunities WHERE id::text=aggregate_id;
  WHEN 'crm_meetings' THEN SELECT pipeline_id INTO result FROM public.crm_meetings WHERE id::text=aggregate_id;
  WHEN 'crm_products' THEN SELECT pipeline_id INTO result FROM public.crm_products WHERE id::text=aggregate_id;
  WHEN 'crm_campaigns' THEN SELECT pipeline_id INTO result FROM public.crm_campaigns WHERE id::text=aggregate_id;
  ELSE RETURN NULL;
 END CASE;
 RETURN result;
END $$;

-- Ordinary Account/Contact/etc projection is not native Email authority.
-- Require the exact current aggregate binding and canonical worker module;
-- unknown/orphaned rows and any Email/module transition remain held.
CREATE FUNCTION clawpilot_crm_native_outbox_is_non_email(aggregate_type text,aggregate_id text,operation text,payload jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT (operation IN ('upsert_record','delete_record','reproject_record')
   AND jsonb_typeof(payload)='object' AND payload->>'localId'=aggregate_id
   AND payload->>'pipelineId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   AND public.clawpilot_crm_native_outbox_pipeline(aggregate_type,aggregate_id)::text=payload->>'pipelineId'
   AND jsonb_typeof(payload->'attributes')='object'
   AND EXISTS(SELECT 1 FROM (VALUES
     ('crm_organizations','organizations','Accounts'),('crm_contacts','contacts','Contacts'),
     ('crm_leads','leads','Leads'),('crm_opportunities','opportunities','Opportunities'),
     ('crm_meetings','meetings','Meetings'),('crm_products','products','AOS_Products'),
     ('crm_campaigns','campaigns','Campaigns')) canonical(aggregate_type,entity,module)
     WHERE canonical.aggregate_type=$1 AND canonical.entity=payload->>'entity'
       AND (NOT payload ? 'suiteCrmModule' OR payload->>'suiteCrmModule'=canonical.module)
       AND (NOT payload ? 'previousSuiteCrmModule' OR payload->>'previousSuiteCrmModule'=canonical.module))
   AND NOT jsonb_path_exists(payload,
     'lax $.** ? (@.suiteCrmModule == "Emails" || @.previousSuiteCrmModule == "Emails" || @.relatedModuleName == "Emails")')) IS TRUE
$$;

-- A completed deletion in a different currently managed scope is not a live
-- writer or authority for this pipeline. It is NEVER adopted as immutable
-- Email history, a native receipt, or readership proof. Active app changes
-- still require their own real complete initial origin and binding omission.
CREATE FUNCTION clawpilot_crm_native_outbox_is_foreign_terminal_delete(o public.sync_outbox,pipeline uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE other public.pipeline_spaces; owner_user public.app_users;
BEGIN
 IF NOT (o.target_system='suitecrm' AND o.aggregate_type='crm_interactions' AND o.operation='delete_record'
   AND o.status='succeeded' AND o.processed_at IS NOT NULL AND o.last_error IS NULL
   AND o.locked_at IS NULL AND o.lock_token IS NULL AND o.attempts>0
   AND jsonb_typeof(o.payload)='object'
   AND o.payload ?& ARRAY['entity','pipelineId','localId','suiteCrmId','attributes']
   AND o.payload-ARRAY['entity','pipelineId','localId','suiteCrmId','attributes','suiteCrmModule']='{}'::jsonb
   AND o.payload->>'entity'='interactions' AND o.payload->>'localId'=o.aggregate_id
   AND o.payload->>'localId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   AND o.payload->>'pipelineId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   AND o.payload->>'suiteCrmId' ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,35}$'
   AND (NOT o.payload ? 'suiteCrmModule' OR o.payload->>'suiteCrmModule' IN ('Notes','Calls','Meetings','Emails'))
   AND o.payload->'attributes'='{}'::jsonb
   AND o.payload->>'pipelineId'<>pipeline::text
   AND NOT public.clawpilot_crm_native_json_has_pipeline(o.payload,pipeline)) IS TRUE THEN RETURN false; END IF;
 SELECT * INTO other FROM public.pipeline_spaces WHERE id::text=o.payload->>'pipelineId';
 IF NOT FOUND OR other.reference_access_disabled OR NOT EXISTS(SELECT 1 FROM public.workspace_organizations w
   WHERE w.id=other.workspace_organization_id AND NOT w.is_demo) THEN RETURN false; END IF;
 SELECT * INTO owner_user FROM public.app_users WHERE email=other.owner_email;
 IF NOT FOUND OR NOT (owner_user.status='active' AND owner_user.crm_user_enabled
   AND owner_user.suitecrm_user_id ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,35}$'
   AND owner_user.suitecrm_username=owner_user.reference_code
   AND (SELECT count(*) FROM public.app_users duplicate WHERE lower(duplicate.suitecrm_user_id)=lower(owner_user.suitecrm_user_id))=1
   AND EXISTS(SELECT 1 FROM public.app_user_organization_memberships m WHERE m.user_email=other.owner_email
     AND m.organization_id=other.workspace_organization_id AND m.status='active' AND m.trashed_at IS NULL
     AND public.clawpilot_crm_root_native_membership_state(to_jsonb(m))->'valid'='true'::jsonb
     AND (m.role='owner' OR m.permissions->'viewCrm' IS DISTINCT FROM 'false'::jsonb))) IS TRUE THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.crm_interactions i WHERE (i.id::text=o.aggregate_id
     AND (i.pipeline_id<>other.id OR i.suitecrm_id IS DISTINCT FROM o.payload->>'suiteCrmId'))
   OR (lower(i.suitecrm_id)=lower(o.payload->>'suiteCrmId') AND (i.pipeline_id<>other.id OR i.id::text<>o.aggregate_id)))
   THEN RETURN false; END IF;
 IF NOT (EXISTS(SELECT 1 FROM public.crm_interactions i WHERE i.pipeline_id=other.id
     AND i.suitecrm_module='Emails' AND i.suitecrm_synced_at IS NOT NULL AND i.suitecrm_id IS NOT NULL)
   OR EXISTS(SELECT 1 FROM public.crm_native_email_capability_policies p WHERE p.pipeline_id=other.id
     AND p.policy->>'workspaceId'=other.workspace_organization_id::text
     AND p.policy->>'ownerSuiteCrmId'=owner_user.suitecrm_user_id)) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.crm_native_email_publication_control c WHERE c.singleton AND c.enabled)
   AND NOT EXISTS(SELECT 1 FROM public.crm_native_email_initial_enrollments e
     JOIN public.crm_native_email_initial_reservations r ON r.operation_id=e.operation_id
     CROSS JOIN LATERAL jsonb_array_elements(e.plan->'pipelines') binding
     WHERE e.state='activated' AND r.state='activated' AND e.native_receipt->>'state'='committed'
       AND e.receipt_canonical::jsonb=e.native_receipt
       AND e.receipt_hash=encode(public.digest(e.receipt_canonical,'sha256'),'hex')
       AND binding.value->'policy'->>'pipelineId'=other.id::text
       AND binding.value->'policy'->>'workspaceId'=other.workspace_organization_id::text
       AND binding.value->'policy'->>'ownerSuiteCrmId'=owner_user.suitecrm_user_id)
   THEN RETURN false; END IF;
 RETURN true;
END $$;

CREATE FUNCTION clawpilot_crm_native_unmanaged_pipeline_footprint(pipeline uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE p public.pipeline_spaces; u public.app_users;
BEGIN
 SELECT * INTO p FROM public.pipeline_spaces WHERE id=pipeline;
 IF NOT FOUND OR p.reference_access_disabled OR NOT EXISTS(SELECT 1 FROM public.workspace_organizations w
   WHERE w.id=p.workspace_organization_id AND NOT w.is_demo) THEN RETURN false; END IF;
 SELECT * INTO u FROM public.app_users WHERE email=p.owner_email;
 -- SQL NULL is intentional app-only identity; blank/0/unknown is not NULL.
 IF NOT FOUND OR u.suitecrm_user_id IS NOT NULL OR u.suitecrm_username IS NOT NULL OR u.crm_user_enabled IS DISTINCT FROM false
   OR NOT (u.status IN ('active','invited','disabled')
     AND u.role IN ('owner','admin','member') AND jsonb_typeof(u.permissions)='object') IS TRUE
   OR NOT EXISTS(SELECT 1 FROM public.app_user_organization_memberships m WHERE m.user_email=u.email
     AND m.organization_id=p.workspace_organization_id
     AND public.clawpilot_crm_root_native_membership_state(to_jsonb(m))->'valid'='true'::jsonb)
   THEN RETURN false; END IF;
 -- Eligibility may change during disable/Trash/restore. Identity must not.
 IF EXISTS(SELECT 1 FROM public.pipeline_space_members m LEFT JOIN public.app_users member_user ON member_user.email=m.user_email
   WHERE m.pipeline_id=pipeline AND (member_user.email IS NULL OR (member_user.suitecrm_user_id IS NOT NULL AND (
     member_user.suitecrm_user_id !~ '^[A-Za-z0-9][A-Za-z0-9-]{0,35}$' OR (SELECT count(*) FROM public.app_users duplicate
       WHERE lower(duplicate.suitecrm_user_id)=lower(member_user.suitecrm_user_id))<>1)))) THEN RETURN false; END IF;
 -- Include every revision/archive/deletion state and legacy Notes projections.
 IF EXISTS(SELECT 1 FROM public.crm_interactions WHERE pipeline_id=pipeline)
   OR EXISTS(SELECT 1 FROM public.crm_interaction_organizations WHERE pipeline_id=pipeline)
   OR EXISTS(SELECT 1 FROM public.crm_interaction_contacts WHERE pipeline_id=pipeline)
   OR EXISTS(SELECT 1 FROM public.crm_integration_actions WHERE pipeline_id=pipeline)
   OR EXISTS(SELECT 1 FROM public.crm_integration_action_attempts attempt JOIN public.crm_integration_actions action
     ON action.id=attempt.action_id WHERE action.pipeline_id=pipeline)
   OR EXISTS(SELECT 1 FROM public.crm_campaign_recipients WHERE pipeline_id=pipeline)
   OR EXISTS(SELECT 1 FROM public.crm_email_sources WHERE intake_pipeline_id=pipeline)
   OR EXISTS(SELECT 1 FROM public.crm_inbound_messages WHERE pipeline_id=pipeline
     OR public.clawpilot_crm_native_json_has_pipeline(raw_metadata,pipeline))
   OR EXISTS(SELECT 1 FROM public.crm_inbound_message_links link JOIN public.crm_inbound_messages message
     ON message.id=link.inbound_message_id WHERE message.pipeline_id=pipeline
       OR public.clawpilot_crm_native_json_has_pipeline(message.raw_metadata,pipeline))
   OR EXISTS(SELECT 1 FROM public.crm_email_review_decisions WHERE pipeline_id=pipeline)
   OR EXISTS(SELECT 1 FROM public.crm_native_email_capability_policies WHERE pipeline_id=pipeline)
   OR EXISTS(SELECT 1 FROM public.crm_native_email_publication_admissions WHERE pipeline_id=pipeline)
   OR EXISTS(SELECT 1 FROM public.crm_native_email_publication_work work JOIN public.crm_native_email_publication_admissions a
     ON a.operation_id=work.operation_id WHERE a.pipeline_id=pipeline)
   OR EXISTS(SELECT 1 FROM public.crm_native_email_authority_member_changes WHERE pipeline_id=pipeline)
   THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.sync_outbox o WHERE o.target_system='suitecrm'
   AND NOT public.clawpilot_crm_native_outbox_is_non_email(o.aggregate_type,o.aggregate_id,o.operation,o.payload)
   AND NOT public.clawpilot_crm_native_outbox_is_foreign_terminal_delete(o,pipeline) AND (
     public.clawpilot_crm_native_json_has_pipeline(o.payload,pipeline)
     OR public.clawpilot_crm_native_outbox_pipeline(o.aggregate_type,o.aggregate_id)=pipeline
     OR (o.aggregate_type='crm_interactions' AND NOT (jsonb_typeof(o.payload)='object'
       AND o.payload->>'pipelineId' ~ '^[a-f0-9-]{36}$'
       AND public.clawpilot_crm_native_outbox_pipeline(o.aggregate_type,o.aggregate_id)::text=o.payload->>'pipelineId') IS TRUE)
     OR (o.status<>'succeeded' AND NOT ((
       (o.operation<>'upsert_user_identity' AND o.status='queued' AND o.attempts=0 AND o.locked_at IS NULL
         AND o.lock_token IS NULL AND o.last_error IS NULL AND o.processed_at IS NULL
         AND jsonb_typeof(o.payload)='object' AND o.payload->>'pipelineId' ~ '^[a-f0-9-]{36}$'
         AND o.operation IN ('upsert_record','delete_record','reproject_record')
         AND public.clawpilot_crm_native_outbox_pipeline(o.aggregate_type,o.aggregate_id)::text=o.payload->>'pipelineId')
       OR public.clawpilot_crm_native_initial_demo_quarantine(o.id,encode(public.digest(to_jsonb(o)::text,'sha256'),'hex'))) IS TRUE))))
   THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.crm_native_email_authority_transitions t WHERE
     public.clawpilot_crm_native_json_has_pipeline(jsonb_build_array(t.plan->'revoke',t.plan->'grant',
       CASE WHEN t.plan->'desiredAppChange'->>'kind'='pipeline_members_v1' THEN t.plan->'desiredAppChange'->'changes' END),pipeline)
     OR (t.plan->'desiredAppChange'->>'kind'='user_identity_link_v1' AND t.plan->'desiredAppChange'->>'userEmail'=p.owner_email))
   OR EXISTS(SELECT 1 FROM public.crm_native_email_authority_phases WHERE public.clawpilot_crm_native_json_has_pipeline(command,pipeline))
   OR EXISTS(SELECT 1 FROM public.crm_native_email_authority_grant_attempts WHERE public.clawpilot_crm_native_json_has_pipeline(command,pipeline))
   OR EXISTS(SELECT 1 FROM public.crm_native_email_initial_enrollments e WHERE
     public.clawpilot_crm_native_json_has_pipeline(jsonb_build_array(e.plan->'pipelines',e.plan->'emails',e.native_delta),pipeline))
   OR EXISTS(SELECT 1 FROM public.crm_native_email_initial_reservations r WHERE
     public.clawpilot_crm_native_json_has_pipeline(jsonb_build_array(r.source_snapshot->'emails',r.source_snapshot->'capabilityPolicies'),pipeline))
   OR EXISTS(SELECT 1 FROM public.audit_events a WHERE (a.event_type='crm.email_association.reviewed'
       OR a.event_type IN ('crm.record.staged','crm.record.archived') AND a.aggregate_type='crm_interactions'
       OR a.event_type ~ '^crm[.]email[._].*(native|publication|project)')
     AND public.clawpilot_crm_native_json_has_pipeline(a.payload,pipeline))
   OR EXISTS(SELECT 1 FROM public.workspace_tenant_retirement_receipts r WHERE
     public.clawpilot_crm_native_json_has_pipeline(r.suitecrm_records,pipeline)) THEN RETURN false; END IF;
 RETURN true;
END $$;

CREATE FUNCTION clawpilot_crm_native_unmanaged_pipeline_retained(pipeline uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE p public.pipeline_spaces;
BEGIN
 IF NOT public.clawpilot_crm_native_unmanaged_pipeline_footprint(pipeline) THEN RETURN false; END IF;
 SELECT * INTO p FROM public.pipeline_spaces WHERE id=pipeline;
 -- This positive origin proves native v1/v2 bindings were exhaustively
 -- installed from the exact approved set, not inferred absent from SQL.
 RETURN EXISTS(SELECT 1 FROM public.crm_native_email_initial_enrollments e
   JOIN public.crm_native_email_initial_reservations r ON r.operation_id=e.operation_id
   WHERE e.state='activated' AND r.state='activated' AND e.native_receipt->>'state'='committed'
     AND e.receipt_canonical::jsonb=e.native_receipt
     AND e.receipt_hash=encode(public.digest(e.receipt_canonical,'sha256'),'hex')
     AND e.source_snapshot=r.source_snapshot AND e.source_fingerprint=r.source_fingerprint
     AND (e.actor_email,e.operator_account_id,e.root_workspace_id,e.native_instance_id,e.generation,e.settling_xid)
       IS NOT DISTINCT FROM (r.actor_email,r.operator_account_id,r.root_workspace_id,r.native_instance_id,r.generation,r.settling_xid)
     AND e.plan_canonical::jsonb=e.plan AND e.plan_hash=encode(public.digest(e.plan_canonical,'sha256'),'hex')
     AND e.native_delta_canonical::jsonb=e.native_delta AND e.delta_fingerprint=encode(public.digest(e.native_delta_canonical,'sha256'),'hex')
     AND e.approval_canonical::jsonb=e.approval_envelope AND e.approval_hash=encode(public.digest(e.approval_canonical,'sha256'),'hex')
     AND e.native_receipt->>'purpose'='clawpilot-native-email-initial-enrollment-receipt'
     AND e.native_receipt->>'operationId'=e.operation_id
     AND e.native_receipt->>'approvalHash'=e.approval_hash
     AND e.native_receipt->>'planHash'=e.plan_hash
     AND e.native_receipt->'result'=e.native_delta->'result'
     AND e.native_receipt->'result'->>'installedRuntimeFingerprint'=e.approval_envelope->'proof'->>'installedRuntimeFingerprint'
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.source_snapshot->'pipelines') x
       WHERE x.value=jsonb_build_object('id',p.id,'owner_email',p.owner_email,
         'workspace_organization_id',p.workspace_organization_id,'reference_access_disabled',false))
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.source_snapshot->'users') x
       WHERE x.value->>'email'=p.owner_email AND x.value->'suitecrm_user_id'='null'::jsonb)
     AND NOT public.clawpilot_crm_native_json_has_pipeline(jsonb_build_array(e.plan->'pipelines',e.plan->'emails',e.native_delta),pipeline));
END $$;

CREATE FUNCTION clawpilot_crm_native_unmanaged_app_change(source_table text,old_row jsonb,new_row jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE candidate jsonb; selected jsonb:=COALESCE(new_row,old_row); p public.pipeline_spaces;
  owner_user public.app_users; target public.app_users; membership public.app_user_organization_memberships;
  candidate_email text; owned uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.crm_native_email_publication_control c WHERE c.singleton AND c.enabled
   AND c.active_operation_id IS NULL AND c.active_transition_id IS NULL AND c.active_initial_enrollment_id IS NULL)
   THEN RETURN false; END IF;
 IF source_table='pipeline_space_members' THEN
  IF selected IS NULL OR (old_row IS NOT NULL AND new_row IS NOT NULL
    AND (old_row->'pipeline_id',old_row->'user_email',old_row->'shared_by',old_row->'created_at') IS DISTINCT FROM
      (new_row->'pipeline_id',new_row->'user_email',new_row->'shared_by',new_row->'created_at')) THEN RETURN false; END IF;
  FOREACH candidate IN ARRAY ARRAY[old_row,new_row] LOOP
   IF candidate IS NULL THEN CONTINUE; END IF;
   IF NOT (public.clawpilot_crm_native_initial_shape(candidate,ARRAY['pipeline_id','user_email','access_role','shared_by','created_at','updated_at'])
     AND candidate->>'access_role' IN ('viewer','editor')) IS TRUE THEN RETURN false; END IF;
  END LOOP;
  SELECT * INTO p FROM public.pipeline_spaces WHERE id::text=selected->>'pipeline_id';
  IF NOT FOUND OR NOT public.clawpilot_crm_native_unmanaged_pipeline_retained(p.id)
    OR selected->>'user_email'=p.owner_email
    OR old_row IS NULL AND selected->>'shared_by' IS DISTINCT FROM p.owner_email THEN RETURN false; END IF;
  SELECT * INTO owner_user FROM public.app_users WHERE email=p.owner_email;
  SELECT * INTO membership FROM public.app_user_organization_memberships
    WHERE user_email=p.owner_email AND organization_id=p.workspace_organization_id;
  IF NOT FOUND OR owner_user.status IS DISTINCT FROM 'active' OR membership.status IS DISTINCT FROM 'active' OR membership.trashed_at IS NOT NULL
    OR public.clawpilot_crm_root_native_membership_state(to_jsonb(membership))->'valid' IS DISTINCT FROM 'true'::jsonb THEN RETURN false; END IF;
  SELECT * INTO target FROM public.app_users WHERE email=selected->>'user_email';
  IF NOT FOUND OR (target.suitecrm_user_id IS NOT NULL AND (target.suitecrm_user_id !~ '^[A-Za-z0-9][A-Za-z0-9-]{0,35}$'
    OR (SELECT count(*) FROM public.app_users other WHERE lower(other.suitecrm_user_id)=lower(target.suitecrm_user_id))<>1))
    THEN RETURN false; END IF;
  -- Stale disabled/trashed intent may be removed. New access follows the
  -- normal app target boundary; mapped targets receive NO native grant.
  IF new_row IS NOT NULL AND (NOT (target.status IN ('active','invited')) IS TRUE OR NOT EXISTS(
    SELECT 1 FROM public.app_user_organization_memberships m WHERE m.user_email=target.email
      AND m.organization_id=p.workspace_organization_id AND m.status='active' AND m.trashed_at IS NULL)
    OR (target.suitecrm_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.crm_native_email_capability_policies policy
      WHERE policy.policy->'principalSuiteCrmUserIds' ? target.suitecrm_user_id))) THEN RETURN false; END IF;
  RETURN true;
 END IF;
 IF source_table IS NULL OR source_table NOT IN ('app_users','app_user_organization_memberships') OR old_row IS NULL OR new_row IS NULL THEN RETURN false; END IF;
 IF source_table='app_users' THEN
  IF (old_row->'email',old_row->'organization_id',old_row->'suitecrm_user_id',old_row->'reference_code',old_row->'suitecrm_username',old_row->'crm_user_enabled')
    IS DISTINCT FROM (new_row->'email',new_row->'organization_id',new_row->'suitecrm_user_id',new_row->'reference_code',new_row->'suitecrm_username',new_row->'crm_user_enabled')
    OR old_row->'suitecrm_user_id' IS DISTINCT FROM 'null'::jsonb OR new_row->'suitecrm_user_id' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  candidate_email:=old_row->>'email';
 ELSE
  IF (old_row->'user_email',old_row->'organization_id') IS DISTINCT FROM (new_row->'user_email',new_row->'organization_id') THEN RETURN false; END IF;
  candidate_email:=old_row->>'user_email';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.app_users u WHERE u.email=candidate_email AND u.suitecrm_user_id IS NULL)
   OR EXISTS(SELECT 1 FROM public.crm_operator_accounts a WHERE a.owner_email=candidate_email) THEN RETURN false; END IF;
 FOREACH candidate IN ARRAY ARRAY[old_row,new_row] LOOP
  IF NOT (candidate->>'status' IN ('active','invited','disabled') AND candidate->>'role' IN ('owner','admin','member')
    AND jsonb_typeof(candidate->'permissions')='object' AND NOT EXISTS(SELECT 1 FROM jsonb_each(candidate->'permissions') x
      WHERE jsonb_typeof(x.value)<>'boolean')) IS TRUE THEN RETURN false; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.pipeline_spaces s WHERE s.owner_email=candidate_email) THEN RETURN false; END IF;
 FOR owned IN SELECT id FROM public.pipeline_spaces WHERE owner_email=candidate_email LOOP
  IF NOT public.clawpilot_crm_native_unmanaged_pipeline_retained(owned) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;

-- Original 0387 classifier is retained verbatim after this narrow new branch.
CREATE OR REPLACE FUNCTION clawpilot_native_email_app_only_change_is_independent(
  source_table text, old_row jsonb, new_row jsonb
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE candidate jsonb; candidate_email text; candidate_workspace text;
BEGIN
  IF public.clawpilot_crm_native_unmanaged_app_change(source_table,old_row,new_row) THEN RETURN true; END IF;
  IF source_table NOT IN ('app_users','app_user_organization_memberships')
    OR (old_row IS NULL AND new_row IS NULL) THEN RETURN false; END IF;
  IF source_table='app_users' AND old_row IS NOT NULL AND new_row IS NOT NULL
    AND old_row->'email' IS DISTINCT FROM new_row->'email' THEN RETURN false; END IF;
  IF source_table='app_users' AND old_row IS NOT NULL AND new_row IS NULL
    AND EXISTS(SELECT 1 FROM public.pipeline_space_members m WHERE m.user_email=old_row->>'email')
    THEN RETURN false; END IF;
  -- Removing or moving a workspace membership cannot leave a retained pipeline
  -- member with missing scope metadata. Trash/disable retain that exact row.
  IF source_table='app_user_organization_memberships' AND old_row IS NOT NULL
    AND (new_row IS NULL OR (old_row->'user_email',old_row->'organization_id') IS DISTINCT FROM
      (new_row->'user_email',new_row->'organization_id'))
    AND EXISTS(SELECT 1 FROM public.pipeline_space_members m JOIN public.pipeline_spaces p ON p.id=m.pipeline_id
      WHERE m.user_email=old_row->>'user_email' AND p.workspace_organization_id::text=old_row->>'organization_id')
    THEN RETURN false; END IF;
  FOREACH candidate IN ARRAY ARRAY[old_row,new_row] LOOP
    IF candidate IS NULL THEN CONTINUE; END IF;
    IF source_table='app_users' THEN
      candidate_email:=candidate->>'email';
      IF NOT (candidate ? 'suitecrm_user_id') OR candidate->'suitecrm_user_id'<>'null'::jsonb
        OR candidate_email IS NULL OR candidate_email='' THEN RETURN false; END IF;
      IF EXISTS(SELECT 1 FROM public.pipeline_spaces p WHERE p.owner_email=candidate_email) THEN RETURN false; END IF;
    ELSE
      candidate_email:=candidate->>'user_email'; candidate_workspace:=candidate->>'organization_id';
      IF candidate_email IS NULL OR candidate_email='' OR candidate_workspace IS NULL
        OR candidate_workspace='' THEN RETURN false; END IF;
      IF EXISTS(SELECT 1 FROM public.app_users u WHERE u.email=candidate_email AND u.suitecrm_user_id IS NOT NULL)
        THEN RETURN false; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.app_users u WHERE u.email=candidate_email)
        AND NOT (old_row IS NOT NULL AND new_row IS NULL) THEN RETURN false; END IF;
      IF EXISTS(SELECT 1 FROM public.pipeline_spaces p
        WHERE p.workspace_organization_id::text=candidate_workspace AND p.owner_email=candidate_email)
        THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_native_json_has_pipeline(jsonb,uuid),
  clawpilot_crm_native_outbox_pipeline(text,text),
  clawpilot_crm_native_outbox_is_non_email(text,text,text,jsonb),
  clawpilot_crm_native_outbox_is_foreign_terminal_delete(public.sync_outbox,uuid),
  clawpilot_crm_native_unmanaged_pipeline_footprint(uuid),clawpilot_crm_native_unmanaged_pipeline_retained(uuid),
  clawpilot_crm_native_unmanaged_app_change(text,jsonb,jsonb) FROM PUBLIC;
