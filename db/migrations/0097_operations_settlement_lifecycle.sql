-- Append-only settlement lifecycle for carrier billing, platform fees, and
-- reseller markups. The settlement row is immutable accounting evidence;
-- status changes are serialized events with operator reasons and references.

CREATE OR REPLACE FUNCTION validate_operations_settlement_event_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_status text;
  reason_text text;
  reference_text text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Settlement events are append-only';
  END IF;

  PERFORM 1
  FROM operations_settlement_entries settlement
  WHERE settlement.network_id = NEW.network_id
    AND settlement.id = NEW.settlement_entry_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Settlement event requires an existing settlement entry';
  END IF;

  SELECT COALESCE(
    (
      SELECT event.event_type
      FROM operations_settlement_events event
      WHERE event.network_id = NEW.network_id
        AND event.settlement_entry_id = NEW.settlement_entry_id
      ORDER BY event.occurred_at DESC, event.created_at DESC, event.id DESC
      LIMIT 1
    ),
    settlement.initial_status
  )
  INTO prior_status
  FROM operations_settlement_entries settlement
  WHERE settlement.network_id = NEW.network_id
    AND settlement.id = NEW.settlement_entry_id;

  reason_text := NULLIF(btrim(COALESCE(NEW.details ->> 'reason', '')), '');
  reference_text := NULLIF(
    btrim(COALESCE(NEW.details ->> 'reference', '')),
    ''
  );

  IF reason_text IS NULL THEN
    RAISE EXCEPTION 'Settlement lifecycle event requires an operator reason';
  END IF;
  IF NEW.event_type IN ('billed', 'paid') AND reference_text IS NULL THEN
    RAISE EXCEPTION
      'Billed and paid settlement events require an external reference';
  END IF;

  IF (
       NEW.event_type = 'approved'
       AND prior_status = 'accrued'
     )
     OR (
       NEW.event_type = 'billed'
       AND prior_status IN ('approved', 'resolved')
     )
     OR (
       NEW.event_type = 'paid'
       AND prior_status IN ('approved', 'billed', 'resolved')
     )
     OR (
       NEW.event_type = 'disputed'
       AND prior_status IN ('approved', 'billed')
     )
     OR (
       NEW.event_type = 'resolved'
       AND prior_status = 'disputed'
     )
     OR (
       NEW.event_type = 'voided'
       AND prior_status IN (
         'accrued', 'approved', 'billed', 'disputed', 'resolved'
       )
     )
     OR (
       NEW.event_type = 'reversed'
       AND prior_status IN ('approved', 'billed', 'resolved')
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Settlement transition from % to % is not allowed',
    prior_status,
    NEW.event_type;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_settlement_event_lifecycle_write
  ON operations_settlement_events;
CREATE TRIGGER validate_operations_settlement_event_lifecycle_write
BEFORE INSERT OR UPDATE OR DELETE ON operations_settlement_events
FOR EACH ROW EXECUTE FUNCTION validate_operations_settlement_event_lifecycle();

CREATE OR REPLACE VIEW operations_settlement_current_status AS
SELECT
  settlement.network_id,
  settlement.id AS settlement_entry_id,
  settlement.global_id AS settlement_global_id,
  COALESCE(latest.event_type, settlement.initial_status) AS current_status,
  latest.global_id AS latest_event_global_id,
  latest.details AS latest_event_details,
  latest.actor_email AS latest_event_actor,
  latest.occurred_at AS latest_event_at
FROM operations_settlement_entries settlement
LEFT JOIN LATERAL (
  SELECT
    event.global_id,
    event.event_type,
    event.details,
    event.actor_email,
    event.occurred_at
  FROM operations_settlement_events event
  WHERE event.network_id = settlement.network_id
    AND event.settlement_entry_id = settlement.id
  ORDER BY event.occurred_at DESC, event.created_at DESC, event.id DESC
  LIMIT 1
) latest ON true;

COMMENT ON VIEW operations_settlement_current_status IS
  'Current lifecycle state derived from immutable settlement evidence and append-only events.';
