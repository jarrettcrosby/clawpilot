-- CRM reads idempotently restage records. Before the adapter honored the outbox
-- conflict result, every restage produced an audit row even when no work queued.
WITH ranked_matches AS (
  SELECT
    event.id AS event_id,
    outbox.id AS outbox_id,
    outbox.idempotency_key,
    row_number() OVER (
      PARTITION BY outbox.id
      ORDER BY abs(extract(epoch FROM (event.created_at - outbox.created_at))), event.id
    ) AS outbox_rank,
    row_number() OVER (
      PARTITION BY event.id
      ORDER BY abs(extract(epoch FROM (event.created_at - outbox.created_at))), outbox.id
    ) AS event_rank
  FROM audit_events event
  JOIN sync_outbox outbox
    ON outbox.target_system = 'suitecrm'
   AND outbox.operation = 'upsert_record'
   AND outbox.aggregate_id = event.aggregate_id
   AND outbox.idempotency_key IS NOT NULL
   AND event.created_at BETWEEN outbox.created_at - interval '5 seconds'
                            AND outbox.created_at + interval '5 seconds'
  WHERE event.event_type = 'crm.record.staged'
    AND event.event_key IS NULL
), keepers AS (
  SELECT event_id, idempotency_key
  FROM ranked_matches
  WHERE outbox_rank = 1 AND event_rank = 1
), removed AS (
  DELETE FROM audit_events event
  WHERE event.event_type = 'crm.record.staged'
    AND event.event_key IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM keepers keeper WHERE keeper.event_id = event.id
    )
  RETURNING event.id
)
UPDATE audit_events event
SET event_key = 'crm-stage:' || keeper.idempotency_key
FROM keepers keeper
WHERE event.id = keeper.event_id;
