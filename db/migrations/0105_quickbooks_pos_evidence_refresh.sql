-- POS parity needs a bounded, on-demand QuickBooks evidence refresh. The full
-- accounting catalog remains on its existing schedule; this timestamp records
-- only the latest SalesReceipt/JournalEntry range refresh.

ALTER TABLE organization_quickbooks_connections
  ADD COLUMN IF NOT EXISTS last_pos_evidence_synced_at timestamptz;
