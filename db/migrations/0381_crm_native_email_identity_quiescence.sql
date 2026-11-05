-- The legacy identity worker PATCHes native users.user_name and can modify
-- users.date_modified even when the logical identity did not change. Native
-- policy fingerprints include full Users rows. Enabled policy must never race
-- a disabled-mode claim that is still outstanding at activation.
--
-- Claims and dispatch authorization already lock the singleton first. This
-- BEFORE UPDATE runs under the same row lock, so a concurrent disabled claim
-- either commits before this check (and is refused), or sees enabled=true and
-- cannot claim. Refuse every non-success identity, not just a live lease:
-- expired/failed/dead attempts can retain an uncertain provider outcome.
--
-- This is a necessary queue barrier, NOT proof that a timed-out remote request
-- has stopped. Production installation/activation still requires independently
-- reviewed native quiescence and current native policy readback. No job is
-- marked succeeded, cancelled, deleted or replayed by this migration.
CREATE FUNCTION clawpilot_native_email_identity_activation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.enabled AND NOT OLD.enabled AND EXISTS (
    SELECT 1 FROM public.sync_outbox
    WHERE target_system='suitecrm' AND operation='upsert_user_identity'
      AND status IS DISTINCT FROM 'succeeded'
  ) THEN
    RAISE EXCEPTION 'Native Email activation requires all legacy identity work to be completed and native writes quiescent'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_native_email_identity_activation_guard BEFORE UPDATE OF enabled
  ON crm_native_email_publication_control FOR EACH ROW
  EXECUTE FUNCTION clawpilot_native_email_identity_activation_guard();
