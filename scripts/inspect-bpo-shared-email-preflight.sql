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
    i.id AS interaction_id,o.id AS job_id,i.pipeline_id,i.organization_id,i.contact_id
  FROM target t JOIN public.crm_interactions i ON i.pipeline_id=t.id
  JOIN LATERAL (SELECT * FROM public.sync_outbox o WHERE o.target_system='suitecrm'
    AND o.aggregate_type='crm_interactions' AND o.aggregate_id=i.id::text ORDER BY o.created_at DESC,o.id DESC LIMIT 1) o ON true
  WHERE i.sync_status='failed' AND i.suitecrm_module='Emails'
    AND o.last_error IN ('native_projection_proof_unavailable',
      'Native Email projection held: exact identity, relationships, or audience proof is unavailable')
), placement AS (
  SELECT jobs.*,live.primary_id,live.accounts,live.contacts,live.contact_accounts,live.local_primary_count,live.primary_contact_present
  FROM jobs JOIN LATERAL (
    WITH org_ids AS (
      SELECT jobs.organization_id AS id WHERE jobs.organization_id IS NOT NULL
      UNION SELECT l.organization_id FROM public.crm_interaction_organizations l WHERE (l.pipeline_id,l.interaction_id)=(jobs.pipeline_id,jobs.interaction_id)
    ), accounts AS (
      SELECT a.id,o.suitecrm_id FROM org_ids a LEFT JOIN public.crm_organizations o
        ON (o.pipeline_id,o.id)=(jobs.pipeline_id,a.id) AND coalesce(lower(o.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
    ), contacts AS (
      SELECT l.contact_id,c.suitecrm_id,a.suitecrm_id AS account_id FROM public.crm_interaction_contacts l
      LEFT JOIN public.crm_contacts c ON (c.pipeline_id,c.id)=(l.pipeline_id,l.contact_id)
        AND coalesce(lower(c.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
      LEFT JOIN accounts a ON a.id=c.organization_id WHERE (l.pipeline_id,l.interaction_id)=(jobs.pipeline_id,jobs.interaction_id)
    ) SELECT (SELECT suitecrm_id FROM accounts WHERE id=jobs.organization_id) AS primary_id,
      coalesce((SELECT jsonb_agg(suitecrm_id ORDER BY suitecrm_id COLLATE "C") FROM accounts),'[]'::jsonb) AS accounts,
      coalesce((SELECT jsonb_agg(suitecrm_id ORDER BY suitecrm_id COLLATE "C") FROM contacts),'[]'::jsonb) AS contacts,
      coalesce((SELECT jsonb_agg(jsonb_build_object('contactId',suitecrm_id,'accountId',account_id)
        ORDER BY suitecrm_id COLLATE "C") FROM contacts),'[]'::jsonb) AS contact_accounts,
      (SELECT count(*) FROM public.crm_interaction_organizations l WHERE (l.pipeline_id,l.interaction_id)=(jobs.pipeline_id,jobs.interaction_id)
        AND l.is_primary AND l.organization_id=jobs.organization_id) AS local_primary_count,
      (jobs.contact_id IS NULL OR EXISTS(SELECT 1 FROM contacts WHERE contact_id=jobs.contact_id)) AS primary_contact_present
  ) live ON true
), counts AS (
  SELECT terminal_date,status,attempts,count(*) AS records,
    count(*) FILTER(WHERE NULLIF(payload#>>'{attributes,assigned_user_id}','') IS NOT NULL) AS with_assignee,
    count(*) FILTER(WHERE NULLIF(payload#>>'{attributes,from_addr_name}','') IS NOT NULL) AS with_from_header,
    count(*) FILTER(WHERE payload#>>'{attributes,global_id_c}'=reference_code
      AND payload->>'suiteCrmId'=suitecrm_id AND jsonb_typeof(payload->'emailProjection')='object') AS with_exact_projection,
    count(*) FILTER(WHERE primary_contact_present AND (organization_id IS NULL OR local_primary_count=1)
      AND coalesce(primary_id,'')=payload#>>'{attributes,parent_id}'
      AND accounts=payload#>'{emailProjection,accounts}' AND contacts=payload#>'{emailProjection,contacts}'
      AND contact_accounts=payload#>'{emailProjection,contactAccounts}') AS with_current_placement,
    count(*) FILTER(WHERE EXISTS (
      SELECT 1 FROM jsonb_each_text(payload->'attributes') AS attr(field,val)
      CROSS JOIN LATERAL regexp_split_to_table(attr.val,',') part
      CROSS JOIN LATERAL (SELECT btrim(split_part(part,'<',1),' "') AS label) parsed
      WHERE field IN ('from_addr_name','to_addrs_names','cc_addrs_names','bcc_addrs_names','reply_to_addrs_names')
        AND (octet_length(attr.val)>CASE WHEN field IN ('from_addr_name','reply_to_addrs_names') THEN 255 ELSE 8000 END
          OR (strpos(part,'<')>0 AND (strpos(label,chr(39))>0 OR strpos(label,chr(34))>0 OR strpos(label,chr(92))>0)))
    )) AS with_unsupported_header_label_or_size,
    count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds h WHERE h.outbox_id=placement.job_id OR h.local_id=placement.interaction_id)
      AND NOT EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.held h WHERE h.outbox_id=placement.job_id OR h.local_id=placement.interaction_id)
      AND NOT EXISTS(SELECT 1 FROM crm_legacy_email_retirement.retained h WHERE h.outbox_id=placement.job_id OR h.local_id=placement.interaction_id)) AS not_held
  FROM placement GROUP BY terminal_date,status,attempts
)
SELECT jsonb_build_object('read_only',current_setting('transaction_read_only'),'exact_target_count',(SELECT count(*) FROM target),
  'legacy_role_mode_enabled',(SELECT enabled FROM public.crm_native_email_publication_control WHERE singleton),
  'counts',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.terminal_date) FROM counts c),'[]'::jsonb));
ROLLBACK;
