ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS suitecrm_user_id text,
  ADD COLUMN IF NOT EXISTS suitecrm_username text;

ALTER TABLE app_users
  DROP CONSTRAINT IF EXISTS app_users_suitecrm_user_id_format,
  ADD CONSTRAINT app_users_suitecrm_user_id_format CHECK (
    suitecrm_user_id IS NULL
    OR suitecrm_user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  DROP CONSTRAINT IF EXISTS app_users_suitecrm_username_length,
  ADD CONSTRAINT app_users_suitecrm_username_length CHECK (
    suitecrm_username IS NULL OR length(suitecrm_username) BETWEEN 1 AND 128
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_suitecrm_user_id
  ON app_users (suitecrm_user_id)
  WHERE suitecrm_user_id IS NOT NULL;

ALTER TABLE crm_interactions
  ADD COLUMN IF NOT EXISTS agent_email text;

ALTER TABLE crm_interactions
  DROP CONSTRAINT IF EXISTS crm_interactions_agent_email_fkey,
  ADD CONSTRAINT crm_interactions_agent_email_fkey
    FOREIGN KEY (agent_email) REFERENCES app_users(email) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_crm_interactions_agent_email
  ON crm_interactions (pipeline_id, agent_email, occurred_at DESC);

WITH candidates AS (
  SELECT interaction.id, min(app_user.email) AS email
  FROM crm_interactions interaction
  JOIN pipeline_spaces pipeline ON pipeline.id = interaction.pipeline_id
  JOIN app_users app_user
    ON app_user.status = 'active'
   AND lower(interaction.agent_name) IN (
     lower(app_user.email),
     lower(COALESCE(app_user.display_name, app_user.email))
   )
  LEFT JOIN pipeline_space_members membership
    ON membership.pipeline_id = interaction.pipeline_id
   AND membership.user_email = app_user.email
  WHERE interaction.agent_email IS NULL
    AND interaction.agent_name IS NOT NULL
    AND (pipeline.owner_email = app_user.email OR membership.user_email IS NOT NULL)
  GROUP BY interaction.id
  HAVING count(DISTINCT app_user.email) = 1
)
UPDATE crm_interactions interaction
SET agent_email = candidates.email,
    updated_at = now()
FROM candidates
WHERE interaction.id = candidates.id;
