-- Archiving is not permission to publish. An explicit disposition in the
-- independently reviewed manifest is required to stage a retained Email.
-- Previously recorded batches default to archive-only; do not infer intent.
LOCK TABLE public.crm_legacy_email_recovery_stages IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_stages) THEN
  RAISE EXCEPTION 'Existing legacy Email staging receipts require a separately reviewed disposition before installation'
   USING ERRCODE='55000';
 END IF;
END $$;

ALTER TABLE crm_legacy_email_retirement.verified_batch
 ADD COLUMN publication_disposition text NOT NULL DEFAULT 'archive_only',
 ADD CONSTRAINT crm_legacy_email_retirement_publication_disposition
 CHECK (publication_disposition IN ('archive_only','reviewed_recovery'));

CREATE OR REPLACE FUNCTION public.clawpilot_crm_legacy_email_stage_source(p_retired uuid,p_retirement text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT COALESCE((SELECT jsonb_build_object('retiredOutboxId',r.outbox_id,
  'retirementReceiptHash',c.receipt_hash,'localId',r.local_id,'pipelineId',r.pipeline_id,'workspaceId',r.workspace_id,
  'nativeId',r.native_id,'globalId',r.global_id,'sourceFingerprint',r.source_hash,'originalFingerprint',r.original_hash,
  'payload',r.original->'payload','idempotencyKey',r.original->>'idempotency_key')
  FROM crm_legacy_email_retirement.retained r JOIN crm_legacy_email_retirement.consumed c USING(batch)
  JOIN crm_legacy_email_retirement.verified_batch b USING(batch)
  WHERE r.outbox_id=p_retired AND c.receipt_hash=p_retirement AND r.historical_provider_outcome='unknown'
    AND b.publication_disposition='reviewed_recovery'
    AND NOT EXISTS(SELECT 1 FROM public.sync_outbox o WHERE o.id=r.outbox_id)),
  '{"state":"unknown"}'::jsonb)
$$;
REVOKE ALL ON FUNCTION public.clawpilot_crm_legacy_email_stage_source(uuid,text) FROM PUBLIC;

-- Guard the actual staging write, not just its operator-facing source read.
-- A raw call to the old 0407 SQL cannot create a hold, replacement, or stage
-- receipt for an archive-only original; the error rolls the statement back.
CREATE FUNCTION crm_legacy_email_retirement.guard_reviewed_recovery_stage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM crm_legacy_email_retirement.retained r
   JOIN crm_legacy_email_retirement.consumed c USING(batch)
   JOIN crm_legacy_email_retirement.verified_batch b USING(batch)
   WHERE r.outbox_id=NEW.retired_outbox_id AND b.publication_disposition='reviewed_recovery') THEN
  RAISE EXCEPTION 'Legacy Email archive disposition does not permit staging' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crm_legacy_email_retirement.guard_reviewed_recovery_stage() FROM PUBLIC;
CREATE TRIGGER crm_legacy_email_stage_reviewed_disposition BEFORE INSERT ON public.crm_legacy_email_recovery_stages
 FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_retirement.guard_reviewed_recovery_stage();
