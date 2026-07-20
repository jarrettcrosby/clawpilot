ALTER TABLE pos_accounting_profiles
  ADD COLUMN IF NOT EXISTS email_notifications_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_notifications_enabled_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pos_accounting_profile_notification_consent_valid'
  ) THEN
    ALTER TABLE pos_accounting_profiles
      ADD CONSTRAINT pos_accounting_profile_notification_consent_valid CHECK (
        (email_notifications_enabled = true AND email_notifications_enabled_at IS NOT NULL)
        OR (email_notifications_enabled = false AND email_notifications_enabled_at IS NULL)
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pos_accounting_notification_recipient_deliverable'
  ) THEN
    ALTER TABLE pos_accounting_notification_outbox
      ADD CONSTRAINT pos_accounting_notification_recipient_deliverable CHECK (
        recipient_email <> 'demo-system@clawpilot.example'
        AND recipient_email !~* '@[^@]*\.(example|invalid|test)$'
        AND recipient_email !~* '@example\.(com|org|net)$'
        AND recipient_email !~* '@localhost$'
      ) NOT VALID;
  END IF;
END
$$;

UPDATE pos_accounting_notification_outbox
SET status = 'cancelled',
    last_error = 'Reserved demo/test recipient blocked',
    locked_at = NULL,
    locked_by = NULL,
    lock_token = NULL,
    updated_at = now()
WHERE status IN ('pending', 'failed', 'processing')
  AND (
    recipient_email = 'demo-system@clawpilot.example'
    OR recipient_email ~* '@[^@]*\.(example|invalid|test)$'
    OR recipient_email ~* '@example\.(com|org|net)$'
    OR recipient_email ~* '@localhost$'
  );
