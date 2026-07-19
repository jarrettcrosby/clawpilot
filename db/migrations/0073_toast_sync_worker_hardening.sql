ALTER TABLE toast_sync_outbox
  ADD COLUMN IF NOT EXISTS lock_token uuid;

ALTER TABLE toast_sync_outbox
  DROP CONSTRAINT IF EXISTS toast_sync_outbox_sync_kind_check;

ALTER TABLE toast_sync_outbox
  ADD CONSTRAINT toast_sync_outbox_sync_kind_check CHECK (
    sync_kind IN ('analytics_sales', 'analytics_payouts', 'standard_orders', 'standard_order_updates')
  );

INSERT INTO app_settings (key, value, updated_at)
VALUES (
  'deployment.database.identity',
  jsonb_build_object('id', gen_random_uuid()::text),
  now()
)
ON CONFLICT (key) DO NOTHING;
