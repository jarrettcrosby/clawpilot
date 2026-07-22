-- Persist the response produced by an idempotent command. Replaying a command
-- must return its original result even after later commands advance the order.
ALTER TABLE operations_command_receipts
  ADD COLUMN IF NOT EXISTS result_payload jsonb;

