LOCK TABLE pos_accounting_issue_states, pos_accounting_notification_outbox
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pos_accounting_notification_outbox
    GROUP BY issue_state_id, recipient_email
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce the POS accounting daily alert fence: duplicate recipient scopes exist';
  END IF;
END
$$;

ALTER TABLE pos_accounting_notification_outbox
  ADD COLUMN IF NOT EXISTS delivery_reserved_at timestamptz;

ALTER TABLE pos_accounting_notification_outbox
  DROP CONSTRAINT IF EXISTS pos_accounting_notification_outbox_status_check;

ALTER TABLE pos_accounting_notification_outbox
  ADD CONSTRAINT pos_accounting_notification_outbox_status_check CHECK (
    status IN ('pending', 'processing', 'failed', 'succeeded', 'dead', 'cancelled', 'suppressed')
  );

-- A legacy retryable or in-flight row has an ambiguous delivery outcome. Preserve
-- successful results, but terminalize every other attempted row before installing
-- the single-attempt contract. Pending/cancelled rows that were never attempted
-- remain eligible for their one delivery reservation.
UPDATE pos_accounting_notification_outbox SET
  status = CASE WHEN status = 'succeeded' THEN 'succeeded' ELSE 'dead' END,
  attempt_count = 1,
  delivery_reserved_at = COALESCE(sent_at, locked_at, updated_at, created_at, now()),
  locked_at = NULL,
  locked_by = NULL,
  lock_token = NULL,
  last_error = CASE
    WHEN status = 'succeeded' THEN last_error
    ELSE COALESCE(
      last_error,
      'Legacy delivery attempt was terminalized when the daily alert fence was installed'
    )
  END,
  updated_at = now()
WHERE status NOT IN ('pending', 'cancelled')
   OR attempt_count <> 0;

ALTER TABLE pos_accounting_notification_outbox
  ADD CONSTRAINT pos_accounting_notification_daily_delivery_unique
  UNIQUE (issue_state_id, recipient_email);

ALTER TABLE pos_accounting_notification_outbox
  DROP CONSTRAINT IF EXISTS pos_accounting_notification_single_attempt_valid;

ALTER TABLE pos_accounting_notification_outbox
  ADD CONSTRAINT pos_accounting_notification_single_attempt_valid
  CHECK (
    (
      status IN ('pending', 'cancelled')
      AND attempt_count = 0
      AND delivery_reserved_at IS NULL
    )
    OR (
      status IN ('processing', 'succeeded', 'dead', 'suppressed')
      AND attempt_count = 1
      AND delivery_reserved_at IS NOT NULL
    )
  );

-- The previous application increments occurrence whenever issue details change
-- or a same-day issue reopens. Keep that column stable during a rolling deploy;
-- one state row now represents the full location/business-date alert window.
CREATE OR REPLACE FUNCTION preserve_pos_accounting_daily_issue_occurrence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.occurrence := OLD.occurrence;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS preserve_pos_accounting_daily_issue_occurrence
  ON pos_accounting_issue_states;

CREATE TRIGGER preserve_pos_accounting_daily_issue_occurrence
BEFORE UPDATE OF occurrence ON pos_accounting_issue_states
FOR EACH ROW
EXECUTE FUNCTION preserve_pos_accounting_daily_issue_occurrence();

CREATE OR REPLACE FUNCTION protect_pos_accounting_notification_delivery_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  stable_occurrence integer;
  current_issue record;
BEGIN
  -- An older rolling replica inserts a fresh occurrence and names the legacy
  -- three-column conflict target. Map that proposed row back to the existing
  -- daily slot so its ON CONFLICT clause remains valid under the new fence.
  IF TG_OP = 'INSERT' THEN
    SELECT existing.occurrence
      INTO stable_occurrence
    FROM pos_accounting_notification_outbox existing
    WHERE existing.issue_state_id = NEW.issue_state_id
      AND existing.recipient_email = NEW.recipient_email
    ORDER BY existing.created_at, existing.id
    LIMIT 1;
    IF FOUND THEN
      NEW.occurrence := stable_occurrence;
    END IF;
    RETURN NEW;
  END IF;

  -- The old reconciler first cancels the prior occurrence and then inserts the
  -- incremented one. The state trigger above keeps the occurrence stable, so
  -- retain and refresh the untouched pending row instead of creating a gap.
  IF OLD.delivery_reserved_at IS NULL
    AND OLD.status = 'pending'
    AND OLD.attempt_count = 0
    AND NEW.status = 'cancelled'
    AND NEW.last_error = 'A newer accounting issue occurrence replaced this delivery'
  THEN
    SELECT issue.status, issue.occurrence, issue.issue_fingerprint, issue.issues
      INTO current_issue
    FROM pos_accounting_issue_states issue
    WHERE issue.id = OLD.issue_state_id;
    IF FOUND AND current_issue.status = 'open' AND current_issue.occurrence = OLD.occurrence THEN
      NEW.status := OLD.status;
      NEW.occurrence := OLD.occurrence;
      NEW.issue_fingerprint := current_issue.issue_fingerprint;
      NEW.issues := current_issue.issues;
      NEW.available_at := OLD.available_at;
      NEW.last_error := OLD.last_error;
    END IF;
  END IF;

  -- Keep a rolling origin/dev worker safe after this migration lands. Its claim
  -- does not know about delivery_reserved_at, so translate that transition into
  -- the new single-attempt reservation before constraints are evaluated.
  IF OLD.delivery_reserved_at IS NULL AND NEW.status = 'processing' THEN
    IF OLD.status <> 'pending' OR OLD.attempt_count <> 0 THEN
      RAISE EXCEPTION 'A POS accounting notification may only be reserved from an unattempted pending row';
    END IF;
    NEW.attempt_count := 1;
    NEW.delivery_reserved_at := COALESCE(NEW.delivery_reserved_at, now());
  END IF;

  -- Old workers express provider failures and expired leases as retryable.
  -- Once a slot is reserved, translate every reopen request into a terminal
  -- result so a rolling replica can never send the same daily alert twice.
  IF OLD.delivery_reserved_at IS NOT NULL
    AND OLD.status = 'processing'
    AND NEW.status IN ('pending', 'failed', 'cancelled')
  THEN
    NEW.status := 'dead';
    NEW.attempt_count := OLD.attempt_count;
    NEW.delivery_reserved_at := OLD.delivery_reserved_at;
    NEW.locked_at := NULL;
    NEW.locked_by := NULL;
    NEW.lock_token := NULL;
    NEW.last_error := COALESCE(
      NEW.last_error,
      'The one daily delivery attempt has an ambiguous outcome and cannot be retried'
    );
  END IF;

  IF OLD.delivery_reserved_at IS NOT NULL THEN
    IF NEW.issue_state_id IS DISTINCT FROM OLD.issue_state_id
      OR NEW.occurrence IS DISTINCT FROM OLD.occurrence
      OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email
      OR NEW.delivery_reserved_at IS DISTINCT FROM OLD.delivery_reserved_at
      OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
    THEN
      RAISE EXCEPTION 'A reserved POS accounting notification delivery cannot be rearmed or reassigned';
    END IF;

    IF OLD.status = 'processing' AND NEW.status NOT IN ('processing', 'succeeded', 'dead', 'suppressed') THEN
      RAISE EXCEPTION 'A reserved POS accounting notification may only succeed or become terminal';
    ELSIF OLD.status IN ('succeeded', 'dead', 'suppressed') AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'A terminal POS accounting notification delivery is immutable';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS protect_pos_accounting_notification_delivery_fence
  ON pos_accounting_notification_outbox;

CREATE TRIGGER protect_pos_accounting_notification_delivery_fence
BEFORE INSERT OR UPDATE ON pos_accounting_notification_outbox
FOR EACH ROW
EXECUTE FUNCTION protect_pos_accounting_notification_delivery_fence();

DROP INDEX IF EXISTS idx_pos_accounting_notification_outbox_claim;

CREATE INDEX idx_pos_accounting_notification_outbox_claim
  ON pos_accounting_notification_outbox (available_at, created_at, id)
  WHERE status = 'pending';

COMMENT ON COLUMN pos_accounting_notification_outbox.delivery_reserved_at IS
  'Irrevocable reservation of this recipient, POS location, and business-date delivery attempt.';

COMMENT ON CONSTRAINT pos_accounting_notification_daily_delivery_unique
  ON pos_accounting_notification_outbox IS
  'At most one delivery slot exists for each recipient, POS location, and business date.';

COMMENT ON CONSTRAINT pos_accounting_notification_single_attempt_valid
  ON pos_accounting_notification_outbox IS
  'A claimed POS accounting alert is attempted at most once; ambiguous outcomes are terminal.';

COMMENT ON FUNCTION protect_pos_accounting_notification_delivery_fence() IS
  'Keeps rolling replicas on the stable daily slot and prevents reserved delivery from being retried, reassigned, or reopened.';

COMMENT ON FUNCTION preserve_pos_accounting_daily_issue_occurrence() IS
  'Keeps one immutable alert occurrence for each POS location and business date, including during rolling deployments.';
