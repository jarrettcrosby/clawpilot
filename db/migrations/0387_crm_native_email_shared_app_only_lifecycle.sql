-- Explicitly unmapped app members do not have a native principal. Their normal
-- status/module/Trash updates can therefore retain pipeline-sharing intent
-- without changing native readership. Complete transition snapshots still
-- freeze these rows through the existing active-transition guard. No mapping,
-- pipeline-owner or pipeline-member mutation is admitted by this helper.
CREATE OR REPLACE FUNCTION clawpilot_native_email_app_only_change_is_independent(
  source_table text, old_row jsonb, new_row jsonb
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE candidate jsonb; candidate_email text; candidate_workspace text;
BEGIN
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
