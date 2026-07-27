-- Carrier account identity used for rating, label creation, and immutable
-- billing-selection evidence. The sender name belongs to the account/address
-- registration rather than the currently signed-in user.

ALTER TABLE operations_carrier_accounts
  ADD COLUMN IF NOT EXISTS sender_name text;

UPDATE operations_carrier_accounts
SET sender_name = COALESCE(
  NULLIF(btrim(registered_address->>'name'), ''),
  NULLIF(btrim(display_name), '')
)
WHERE sender_name IS NULL OR btrim(sender_name) = '';

ALTER TABLE operations_carrier_accounts
  ALTER COLUMN sender_name SET NOT NULL,
  DROP CONSTRAINT IF EXISTS operations_carrier_accounts_sender_name_valid;

ALTER TABLE operations_carrier_accounts
  ADD CONSTRAINT operations_carrier_accounts_sender_name_valid CHECK (
    sender_name = btrim(sender_name)
    AND char_length(sender_name) BETWEEN 1 AND 120
    AND sender_name !~ '[[:cntrl:]]'
  );
