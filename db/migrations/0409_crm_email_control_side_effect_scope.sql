-- Publishing one Email changes only the active publication pointer and its
-- timestamp. With native authority enabled, those writes do not change the
-- delegated access predicate in 0396 or either authority/enrollment receipt.
-- Keep the same fail-closed checks for every relevant control transition, but
-- do not require an exact Email publisher to read enrollment evidence or
-- update unrelated browser sessions. Other source/receipt triggers remain.

DROP TRIGGER crm_root_control_sessions ON public.crm_native_email_publication_control;
CREATE TRIGGER crm_root_control_sessions AFTER UPDATE OF enabled,active_transition_id,active_initial_enrollment_id,
 generation,verified_generation,native_policy_fingerprint,activation_receipt_hash ON public.crm_native_email_publication_control
 FOR EACH ROW WHEN (
  ROW(OLD.enabled,OLD.active_transition_id,OLD.active_initial_enrollment_id,OLD.generation,
      OLD.verified_generation,OLD.native_policy_fingerprint,OLD.activation_receipt_hash)
   IS DISTINCT FROM
  ROW(NEW.enabled,NEW.active_transition_id,NEW.active_initial_enrollment_id,NEW.generation,
      NEW.verified_generation,NEW.native_policy_fingerprint,NEW.activation_receipt_hash)
 ) EXECUTE FUNCTION public.clawpilot_crm_root_revoke_ineligible_sessions();
-- The non-enrolled read predicate still requires an idle publication pointer.
CREATE TRIGGER crm_root_inactive_publication_sessions AFTER UPDATE OF active_operation_id ON public.crm_native_email_publication_control
 FOR EACH ROW WHEN (NOT NEW.enabled AND OLD.active_operation_id IS DISTINCT FROM NEW.active_operation_id)
 EXECUTE FUNCTION public.clawpilot_crm_root_revoke_ineligible_sessions();

DROP TRIGGER crm_native_capability_control_complete ON public.crm_native_email_publication_control;
CREATE CONSTRAINT TRIGGER crm_native_capability_control_complete AFTER UPDATE OF enabled,active_transition_id,generation,
 verified_generation,native_policy_fingerprint,activation_receipt_hash ON public.crm_native_email_publication_control
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (
  ROW(OLD.enabled,OLD.active_transition_id,OLD.generation,OLD.verified_generation,OLD.native_policy_fingerprint,OLD.activation_receipt_hash)
   IS DISTINCT FROM
  ROW(NEW.enabled,NEW.active_transition_id,NEW.generation,NEW.verified_generation,NEW.native_policy_fingerprint,NEW.activation_receipt_hash)
 ) EXECUTE FUNCTION public.clawpilot_native_email_capability_phase_complete();

DROP TRIGGER crm_native_initial_control_complete ON public.crm_native_email_publication_control;
CREATE CONSTRAINT TRIGGER crm_native_initial_control_complete AFTER UPDATE OF enabled,active_initial_enrollment_id,generation,
 verified_generation,native_policy_fingerprint,activation_receipt_hash ON public.crm_native_email_publication_control
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (
  ROW(OLD.enabled,OLD.active_initial_enrollment_id,OLD.generation,OLD.verified_generation,
      OLD.native_policy_fingerprint,OLD.activation_receipt_hash)
   IS DISTINCT FROM
  ROW(NEW.enabled,NEW.active_initial_enrollment_id,NEW.generation,NEW.verified_generation,
      NEW.native_policy_fingerprint,NEW.activation_receipt_hash)
 ) EXECUTE FUNCTION public.clawpilot_crm_native_initial_complete();
