-- Diagnostic only. No body, mailbox ID, user data, credential or writer.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL statement_timeout = '6s';
WITH target AS (
  SELECT p.id FROM public.pipeline_spaces p JOIN public.workspace_organizations w ON w.id=p.workspace_organization_id
  WHERE p.id='587c8746-ecf6-40ae-8c50-e456f99ad555' AND w.id='c6c49765-9bf6-4223-9261-7553499f5d92'
    AND NOT w.is_demo AND NOT p.reference_access_disabled
), jobs AS (
  SELECT o.status,o.attempts,o.processed_at::date AS terminal_date,o.payload,i.reference_code,i.suitecrm_id,
    i.provider_message_id,i.id AS interaction_id,o.id AS job_id
  FROM target t JOIN public.crm_interactions i ON i.pipeline_id=t.id
  JOIN LATERAL (SELECT * FROM public.sync_outbox o WHERE o.target_system='suitecrm'
    AND o.aggregate_type='crm_interactions' AND o.aggregate_id=i.id::text ORDER BY o.created_at DESC,o.id DESC LIMIT 1) o ON true
  WHERE i.sync_status='failed' AND i.suitecrm_module='Emails'
    AND o.last_error IN ('native_projection_proof_unavailable',
      'Native Email projection held: exact identity, relationships, or audience proof is unavailable')
), counts AS (
  SELECT terminal_date,status,attempts,count(*) AS records,
    count(*) FILTER(WHERE NULLIF(payload#>>'{attributes,assigned_user_id}','') IS NOT NULL) AS with_assignee,
    count(*) FILTER(WHERE NULLIF(payload#>>'{attributes,from_addr_name}','') IS NOT NULL) AS with_from_header,
    count(*) FILTER(WHERE payload#>>'{attributes,global_id_c}'=reference_code
      AND payload->>'suiteCrmId'=suitecrm_id AND jsonb_typeof(payload->'emailProjection')='object') AS with_exact_projection,
    count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds h WHERE h.outbox_id=jobs.job_id OR h.local_id=jobs.interaction_id)
      AND NOT EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.held h WHERE h.outbox_id=jobs.job_id OR h.local_id=jobs.interaction_id)
      AND NOT EXISTS(SELECT 1 FROM crm_legacy_email_retirement.retained h WHERE h.outbox_id=jobs.job_id OR h.local_id=jobs.interaction_id)) AS not_held
  FROM jobs GROUP BY terminal_date,status,attempts
)
SELECT jsonb_build_object('read_only',current_setting('transaction_read_only'),'exact_target_count',(SELECT count(*) FROM target),
  'legacy_role_mode_enabled',(SELECT enabled FROM public.crm_native_email_publication_control WHERE singleton),
  'counts',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.terminal_date) FROM counts c),'[]'::jsonb));
ROLLBACK;
