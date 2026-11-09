-- Exact candidate manifest only. Do not treat capture as write authorization.
-- This query emits identity and row hashes, never email content or credentials.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL statement_timeout = '6s';
SET LOCAL row_security = off;
WITH origin AS (
  SELECT encode(sha256(convert_to(jsonb_build_array('clawpilot-bpo-failed-email-postgres-v1',
    d.datname,d.oid::text,c.system_identifier::text,s.value->>'id')::text,'UTF8')),'hex') AS fingerprint
  FROM pg_database d CROSS JOIN pg_control_system() c
  JOIN public.app_settings s ON s.key='deployment.database.identity'
  WHERE d.datname=current_database() AND NOT pg_is_in_recovery()
    AND s.value->>'id' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
), target AS (
  SELECT p.id FROM public.pipeline_spaces p JOIN public.workspace_organizations w ON w.id=p.workspace_organization_id
  WHERE p.id='587c8746-ecf6-40ae-8c50-e456f99ad555' AND w.id='c6c49765-9bf6-4223-9261-7553499f5d92'
    AND NOT w.is_demo AND NOT p.reference_access_disabled
), exact AS (
  SELECT i.id::text AS "interactionId",o.id::text AS "jobId",i.suitecrm_id AS "nativeId",i.reference_code AS "globalId",
    NULLIF(lower(btrim(i.provider_message_id)),'') AS "providerMessageId",o.processed_at::date AS "terminalDate",
    encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex') AS "interactionFingerprint",
    encode(sha256(convert_to(to_jsonb(o)::text,'UTF8')),'hex') AS "jobFingerprint",
    encode(sha256(convert_to(jsonb_build_array(to_jsonb(i),to_jsonb(o))::text,'UTF8')),'hex') AS "preimageFingerprint"
  FROM target t JOIN public.crm_interactions i ON i.pipeline_id=t.id
  JOIN LATERAL (SELECT * FROM public.sync_outbox o WHERE o.target_system='suitecrm'
    AND o.aggregate_type='crm_interactions' AND o.aggregate_id=i.id::text ORDER BY o.created_at DESC,o.id DESC LIMIT 1) o ON true
  WHERE i.sync_status='failed' AND i.suitecrm_module='Emails' AND i.suitecrm_synced_at IS NULL
    AND o.status='dead' AND o.attempts=8 AND o.locked_at IS NULL AND o.lock_token IS NULL
    AND o.processed_at::date IN ('2026-11-06','2026-11-09')
    AND o.last_error IN ('native_projection_proof_unavailable',
      'Native Email projection held: exact identity, relationships, or audience proof is unavailable')
    AND o.payload->>'entity'='interactions' AND o.payload->>'pipelineId'=i.pipeline_id::text AND o.payload->>'localId'=i.id::text
    AND o.payload->>'suiteCrmId'=i.suitecrm_id AND o.payload#>>'{attributes,global_id_c}'=i.reference_code
    AND o.payload->>'suiteCrmModule'='Emails' AND o.payload->>'previousSuiteCrmModule' IS NULL
    AND o.idempotency_key='crm:interactions:v4:'||i.id::text||':Emails:'||i.source_hash
    AND COALESCE(lower(i.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
    AND NOT (i.metadata ?| ARRAY['suiteCrmEmailProjection','suiteCrmEmailPublication'])
    AND NOT EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds h WHERE h.outbox_id=o.id OR h.local_id=i.id)
    AND NOT EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.held h WHERE h.outbox_id=o.id OR h.local_id=i.id)
    AND NOT EXISTS(SELECT 1 FROM crm_legacy_email_retirement.retained h WHERE h.outbox_id=o.id OR h.local_id=i.id)
)
SELECT jsonb_build_object('version',1,'readOnly',current_setting('transaction_read_only')='on',
  'purpose','clawpilot-bpo-terminal-email-candidate-inventory','originFingerprint',(SELECT fingerprint FROM origin),
  'original11',coalesce((SELECT jsonb_agg(to_jsonb(e)-'terminalDate' ORDER BY "interactionId") FROM exact e WHERE "terminalDate"='2026-11-06'),'[]'::jsonb),
  'later8',coalesce((SELECT jsonb_agg(to_jsonb(e)-'terminalDate' ORDER BY "interactionId") FROM exact e WHERE "terminalDate"='2026-11-09'),'[]'::jsonb));
ROLLBACK;
