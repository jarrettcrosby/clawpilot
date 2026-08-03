-- Support the current-issue projection without sorting every retained
-- historical rejection row for an account.
-- Keep this index key-only. external_id is constrained to 512 characters by
-- the owning table; variable-width rejection payloads such as safe_message
-- must remain in the heap so a valid row cannot exceed PostgreSQL's B-tree
-- index-tuple limit.

CREATE INDEX IF NOT EXISTS
  commerce_intake_rejections_current_identity_idx
  ON operations_commerce_intake_rejections (
    organization_id,
    integration_account_id,
    resource_type,
    external_id,
    created_at DESC,
    id DESC
  );
