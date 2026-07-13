WITH ranked_invitations AS (
  SELECT
    id,
    row_number() OVER (PARTITION BY email ORDER BY created_at DESC, id DESC) AS position
  FROM app_user_invitations
  WHERE accepted_at IS NULL
    AND revoked_at IS NULL
)
UPDATE app_user_invitations invitation
SET revoked_at = now(), updated_at = now()
FROM ranked_invitations ranked
WHERE invitation.id = ranked.id
  AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_user_invitations_one_active
  ON app_user_invitations (email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE release_entries
  ADD COLUMN IF NOT EXISTS release_key text;

UPDATE release_entries
SET release_key = CASE
  WHEN NULLIF(btrim(deployment_id), '') IS NOT NULL THEN 'deployment:' || btrim(deployment_id)
  ELSE 'commit:' || commit_hash
END
WHERE release_key IS NULL OR btrim(release_key) = '';

ALTER TABLE release_entries
  ALTER COLUMN release_key SET NOT NULL;

ALTER TABLE release_entries
  DROP CONSTRAINT IF EXISTS release_entries_environment_commit_hash_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_release_entries_environment_key
  ON release_entries (environment, release_key);
