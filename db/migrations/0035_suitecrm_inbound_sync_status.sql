UPDATE crm_organizations record
SET sync_status = 'synced',
    sync_error = NULL,
    suitecrm_synced_at = COALESCE(record.suitecrm_synced_at, record.updated_at, now()),
    updated_at = now()
WHERE record.suitecrm_id IS NOT NULL
  AND record.source_payload ? 'suiteCrmInbound'
  AND record.sync_status <> 'synced'
  AND NOT EXISTS (
    SELECT 1
    FROM sync_outbox outbox
    WHERE outbox.target_system = 'suitecrm'
      AND outbox.aggregate_type = 'crm_organizations'
      AND outbox.aggregate_id = record.id::text
      AND outbox.status <> 'succeeded'
  );

UPDATE crm_contacts record
SET sync_status = 'synced',
    sync_error = NULL,
    suitecrm_synced_at = COALESCE(record.suitecrm_synced_at, record.updated_at, now()),
    updated_at = now()
WHERE record.suitecrm_id IS NOT NULL
  AND record.source_payload ? 'suiteCrmInbound'
  AND record.sync_status <> 'synced'
  AND NOT EXISTS (
    SELECT 1
    FROM sync_outbox outbox
    WHERE outbox.target_system = 'suitecrm'
      AND outbox.aggregate_type = 'crm_contacts'
      AND outbox.aggregate_id = record.id::text
      AND outbox.status <> 'succeeded'
  );

UPDATE crm_interactions record
SET sync_status = 'synced',
    sync_error = NULL,
    suitecrm_synced_at = COALESCE(record.suitecrm_synced_at, record.updated_at, now()),
    updated_at = now()
WHERE record.suitecrm_id IS NOT NULL
  AND record.source_payload ? 'suiteCrmInbound'
  AND record.sync_status <> 'synced'
  AND NOT EXISTS (
    SELECT 1
    FROM sync_outbox outbox
    WHERE outbox.target_system = 'suitecrm'
      AND outbox.aggregate_type = 'crm_interactions'
      AND outbox.aggregate_id = record.id::text
      AND outbox.status <> 'succeeded'
  );
