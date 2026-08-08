ALTER TABLE operations_pick_tasks
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

UPDATE operations_pick_tasks
SET assigned_at = created_at
WHERE assigned_to IS NOT NULL
  AND assigned_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_operations_pick_tasks_picker_performance
  ON operations_pick_tasks(organization_id, assigned_to, picked_at DESC)
  WHERE status = 'picked' AND assigned_to IS NOT NULL;
