-- A physical print whose socket outcome is uncertain must never be placed back
-- on the automatic delivery queue. This is a database backstop beneath the API
-- and worker invariants so a buggy or compromised enrolled agent cannot cause a
-- duplicate label by pairing PRINT_OUTCOME_UNCERTAIN with retryable=true.

CREATE OR REPLACE FUNCTION prevent_operations_uncertain_print_retry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_state text;
  previous_error_code text;
BEGIN
  IF NEW.state <> 'queued' THEN
    RETURN NEW;
  END IF;

  -- Serialize against the existing transition validator and any concurrent
  -- failed-attempt insert before examining the append-only latest attempt.
  -- Without this row lock, a queued insert could observe the prior claimed
  -- record and wait only after it had already passed this guard.
  PERFORM 1
    FROM operations_print_jobs job
   WHERE job.organization_id = NEW.organization_id
     AND job.id = NEW.print_job_id
   FOR UPDATE;

  SELECT attempt.state, attempt.error_code
    INTO previous_state, previous_error_code
    FROM operations_print_delivery_attempts attempt
   WHERE attempt.organization_id = NEW.organization_id
     AND attempt.print_job_id = NEW.print_job_id
   ORDER BY attempt.sequence_number DESC
   LIMIT 1;

  IF previous_state = 'failed'
     AND previous_error_code = 'PRINT_OUTCOME_UNCERTAIN' THEN
    RAISE EXCEPTION
      'an uncertain physical print outcome may not be queued automatically'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_operations_uncertain_print_retry_write
  ON operations_print_delivery_attempts;
CREATE TRIGGER prevent_operations_uncertain_print_retry_write
BEFORE INSERT ON operations_print_delivery_attempts
FOR EACH ROW
WHEN (NEW.state = 'queued')
EXECUTE FUNCTION prevent_operations_uncertain_print_retry();

COMMENT ON FUNCTION prevent_operations_uncertain_print_retry() IS
  'Permanently blocks automatic retry after PRINT_OUTCOME_UNCERTAIN.';

-- Rolling-upgrade repair: older application versions could revoke/unbind the
-- sole local agent while leaving its current job claimed. There may be no
-- authenticated agent left to run expiry recovery, so terminalize those exact
-- claims conservatively during migration. The append-only attempt projection
-- clears current ownership and the guard above forbids a later auto-requeue.
DO $$
DECLARE
  stranded record;
  repair_key text;
BEGIN
  FOR stranded IN
    SELECT
      job.organization_id,
      job.id AS print_job_id,
      job.global_id AS print_job_global_id,
      job.printer_id,
      job.current_claim_attempt_id,
      agent.global_id AS print_agent_global_id
    FROM operations_print_jobs job
    JOIN operations_print_agents agent
      ON agent.organization_id = job.organization_id
     AND agent.id = job.claimed_by_print_agent_id
    JOIN operations_printers printer
      ON printer.organization_id = job.organization_id
     AND printer.id = job.printer_id
    WHERE job.status = 'claimed'
      AND (
        agent.status <> 'active'
        OR printer.local_print_agent_id IS DISTINCT FROM agent.id
      )
    ORDER BY job.id
    FOR UPDATE OF job
  LOOP
    repair_key := 'print-agent:migration-0296:uncertain:'
      || stranded.current_claim_attempt_id::text;
    INSERT INTO operations_print_delivery_attempts (
      organization_id, print_job_id, printer_id,
      state, actor_type, claim_attempt_id,
      idempotency_key, request_fingerprint,
      detail, error_code, error_message
    ) VALUES (
      stranded.organization_id,
      stranded.print_job_id,
      stranded.printer_id,
      'failed',
      'system',
      stranded.current_claim_attempt_id,
      repair_key,
      encode(digest(
        'migration-0296-stranded-claim' || chr(10)
          || stranded.organization_id::text || chr(10)
          || stranded.print_job_id::text || chr(10)
          || stranded.current_claim_attempt_id::text,
        'sha256'
      ), 'hex'),
      'Migration repaired a claim owned by a revoked or unbound print agent',
      'PRINT_OUTCOME_UNCERTAIN',
      'The owning print agent was revoked or unbound while this claim was unresolved; automatic retry is blocked'
    );

    INSERT INTO audit_events (
      event_type, aggregate_type, aggregate_id, payload, event_key,
      organization_id, is_system
    ) VALUES (
      'operations.print_job.outcome_uncertain',
      'operations.print_job',
      stranded.print_job_global_id,
      jsonb_build_object(
        'printJobGlobalId', stranded.print_job_global_id,
        'printAgentGlobalId', stranded.print_agent_global_id,
        'claimToken', stranded.current_claim_attempt_id,
        'errorCode', 'PRINT_OUTCOME_UNCERTAIN',
        'automaticRetryBlocked', true,
        'migrationRepair', '0296'
      ),
      'operations:print-job:migration-0296:'
        || stranded.current_claim_attempt_id::text,
      stranded.organization_id,
      true
    ) ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING;
  END LOOP;
END;
$$;
