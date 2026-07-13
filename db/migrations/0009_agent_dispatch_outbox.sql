CREATE INDEX IF NOT EXISTS idx_sync_outbox_agent_dispatch_due
  ON sync_outbox (status, available_at, created_at)
  WHERE target_system = 'agent_runtime'
    AND aggregate_type = 'agent_task'
    AND status IN ('queued', 'failed', 'processing');
