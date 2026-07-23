-- Project interaction-shaped calls and meetings into SuiteCRM's native activity
-- modules. The shared stable SuiteCRM ID is retained while the legacy Note is
-- deleted by the reproject_record worker operation.

ALTER TABLE crm_interactions
  ADD COLUMN IF NOT EXISTS suitecrm_module text,
  ADD COLUMN IF NOT EXISTS activity_status text,
  ADD COLUMN IF NOT EXISTS duration_minutes integer;

ALTER TABLE crm_interactions
  DROP CONSTRAINT IF EXISTS crm_interactions_suitecrm_module_valid,
  DROP CONSTRAINT IF EXISTS crm_interactions_activity_status_valid,
  DROP CONSTRAINT IF EXISTS crm_interactions_duration_minutes_valid;

ALTER TABLE crm_interactions
  ADD CONSTRAINT crm_interactions_suitecrm_module_valid CHECK (
    suitecrm_module IS NULL OR suitecrm_module IN ('Notes', 'Calls', 'Meetings')
  ),
  ADD CONSTRAINT crm_interactions_activity_status_valid CHECK (
    activity_status IS NULL OR activity_status IN ('planned', 'held', 'not_held')
  ),
  ADD CONSTRAINT crm_interactions_duration_minutes_valid CHECK (
    duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 1440
  );

UPDATE crm_interactions
SET
  interaction_type = CASE
    WHEN lower(btrim(COALESCE(interaction_type, ''))) = 'call'
      THEN 'call'
    WHEN lower(regexp_replace(btrim(COALESCE(interaction_type, '')), '[-_]+', ' ', 'g'))
      IN ('meeting', 'in person')
      THEN 'meeting'
    WHEN lower(regexp_replace(btrim(COALESCE(interaction_type, '')), '[-_]+', ' ', 'g'))
      = 'email'
      THEN 'email'
    WHEN lower(btrim(COALESCE(interaction_type, ''))) = 'note'
      THEN 'note'
    WHEN lower(btrim(COALESCE(interaction_type, ''))) = 'campaign'
      THEN 'campaign'
    ELSE lower(btrim(COALESCE(interaction_type, 'note')))
  END,
  occurred_at = CASE
    WHEN source_sheet_id IS NOT NULL
      AND COALESCE(source_payload->>'Date', '') ~
        '^[A-Z][a-z]{2} [A-Z][a-z]{2} [0-9]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT[+-][0-9]{4}'
      THEN substring(source_payload->>'Date' from 1 for 33)::timestamptz
    ELSE occurred_at
  END;

UPDATE crm_interactions
SET
  suitecrm_module = CASE
    WHEN interaction_type = 'call' THEN 'Calls'
    WHEN interaction_type = 'meeting' AND meeting_id IS NULL THEN 'Meetings'
    WHEN interaction_type = 'meeting' AND meeting_id IS NOT NULL THEN NULL
    ELSE 'Notes'
  END,
  activity_status = CASE
    WHEN interaction_type NOT IN ('call', 'meeting') THEN NULL
    WHEN lower(regexp_replace(btrim(COALESCE(delivery_status, '')), '[-_]+', ' ', 'g'))
      IN ('planned', 'queued', 'scheduled')
      THEN 'planned'
    WHEN lower(regexp_replace(btrim(COALESCE(delivery_status, '')), '[-_]+', ' ', 'g'))
      IN ('cancelled', 'canceled', 'failed', 'not held', 'missed')
      THEN 'not_held'
    WHEN occurred_at > now() THEN 'planned'
    ELSE 'held'
  END,
  duration_minutes = CASE
    WHEN interaction_type = 'call' THEN 15
    WHEN interaction_type = 'meeting' THEN 30
    ELSE NULL
  END;

CREATE INDEX IF NOT EXISTS idx_crm_interactions_suitecrm_module
  ON crm_interactions (pipeline_id, suitecrm_module, occurred_at DESC, id)
  WHERE suitecrm_module IS NOT NULL;

-- Supersede legacy queued Note writes. Succeeded rows remain as immutable
-- delivery history; reproject_record is intentionally unknown to old workers,
-- so these jobs cannot run until the matching application release is active.
DELETE FROM sync_outbox outbox
USING crm_interactions interaction
WHERE outbox.target_system = 'suitecrm'
  AND outbox.aggregate_type = 'crm_interactions'
  AND outbox.aggregate_id = interaction.id::text
  AND outbox.operation IN ('upsert_record', 'reproject_record')
  AND outbox.status IN ('queued', 'failed', 'dead')
  AND (
    interaction.suitecrm_module IN ('Calls', 'Meetings')
    OR interaction.suitecrm_module IS NULL
  );

WITH activity_projection AS (
  SELECT
    interaction.*,
    organization.suitecrm_id AS organization_suitecrm_id,
    lead.suitecrm_id AS lead_suitecrm_id,
    opportunity.suitecrm_id AS opportunity_suitecrm_id,
    app_user.suitecrm_user_id,
    CASE
      WHEN opportunity.suitecrm_id IS NOT NULL THEN 'Opportunities'
      WHEN lead.suitecrm_id IS NOT NULL THEN 'Leads'
      WHEN organization.suitecrm_id IS NOT NULL THEN 'Accounts'
      ELSE NULL
    END AS parent_type,
    COALESCE(
      opportunity.suitecrm_id,
      lead.suitecrm_id,
      organization.suitecrm_id
    ) AS parent_id
  FROM crm_interactions interaction
  LEFT JOIN crm_organizations organization
    ON organization.pipeline_id = interaction.pipeline_id
   AND organization.id = interaction.organization_id
  LEFT JOIN crm_leads lead
    ON lead.pipeline_id = interaction.pipeline_id
   AND lead.id = interaction.lead_id
  LEFT JOIN crm_opportunities opportunity
    ON opportunity.pipeline_id = interaction.pipeline_id
   AND opportunity.id = interaction.opportunity_id
  LEFT JOIN app_users app_user
    ON app_user.email = interaction.agent_email
  WHERE interaction.suitecrm_module IN ('Calls', 'Meetings')
     OR interaction.suitecrm_module IS NULL
), payloads AS (
  SELECT
    activity.*,
    jsonb_strip_nulls(jsonb_build_object(
      'entity', 'interactions',
      'pipelineId', activity.pipeline_id::text,
      'localId', activity.id::text,
      'suiteCrmId', activity.suitecrm_id,
      'suiteCrmModule', activity.suitecrm_module,
      'previousSuiteCrmModule', 'Notes',
      'attributes', CASE
        WHEN activity.suitecrm_module IS NULL THEN '{}'::jsonb
        ELSE jsonb_strip_nulls(jsonb_build_object(
          'global_id_c', activity.reference_code,
          'name', activity.subject,
          'date_start', to_char(activity.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
          'duration_hours', activity.duration_minutes / 60,
          'duration_minutes', activity.duration_minutes % 60,
          'status', CASE activity.activity_status
            WHEN 'planned' THEN 'Planned'
            WHEN 'not_held' THEN 'Not Held'
            ELSE 'Held'
          END,
          'direction', CASE
            WHEN activity.suitecrm_module = 'Calls'
              THEN CASE WHEN lower(COALESCE(activity.direction, '')) = 'inbound' THEN 'Inbound' ELSE 'Outbound' END
            ELSE NULL
          END,
          'parent_type', activity.parent_type,
          'parent_id', activity.parent_id,
          'assigned_user_id', activity.suitecrm_user_id,
          'description', COALESCE(activity.description, '')
        ))
      END,
      'relationships', CASE
        WHEN activity.suitecrm_module IS NULL THEN NULL
        ELSE COALESCE((
          SELECT jsonb_agg(relationship ORDER BY sort_order, relationship->>'relatedBeanId')
          FROM (
            SELECT 0 AS sort_order, jsonb_build_object(
              'linkFieldName', 'accounts',
              'relatedModuleName', 'Accounts',
              'relatedBeanId', activity.organization_suitecrm_id
            ) AS relationship
            WHERE activity.organization_suitecrm_id IS NOT NULL
            UNION ALL
            SELECT 10 + selected.sort_order, jsonb_build_object(
              'linkFieldName', 'contacts',
              'relatedModuleName', 'Contacts',
              'relatedBeanId', contact.suitecrm_id
            )
            FROM crm_interaction_contacts selected
            JOIN crm_contacts contact
              ON contact.pipeline_id = selected.pipeline_id
             AND contact.id = selected.contact_id
            WHERE selected.pipeline_id = activity.pipeline_id
              AND selected.interaction_id = activity.id
              AND contact.suitecrm_id IS NOT NULL
            UNION ALL
            SELECT 1000, jsonb_build_object(
              'linkFieldName', 'leads',
              'relatedModuleName', 'Leads',
              'relatedBeanId', activity.lead_suitecrm_id
            )
            WHERE activity.lead_suitecrm_id IS NOT NULL
            UNION ALL
            SELECT 1001, jsonb_build_object(
              'linkFieldName', 'opportunity',
              'relatedModuleName', 'Opportunities',
              'relatedBeanId', activity.opportunity_suitecrm_id
            )
            WHERE activity.suitecrm_module = 'Meetings'
              AND activity.opportunity_suitecrm_id IS NOT NULL
          ) related
        ), '[]'::jsonb)
      END
    )) AS payload
  FROM activity_projection activity
)
INSERT INTO sync_outbox (
  aggregate_type,
  aggregate_id,
  operation,
  target_system,
  payload,
  status,
  attempts,
  idempotency_key,
  created_at,
  available_at,
  updated_at
)
SELECT
  'crm_interactions',
  payload.id::text,
  'reproject_record',
  'suitecrm',
  payload.payload,
  'queued',
  0,
  'crm:interactions:activity-projection:v1:' || payload.id::text,
  now(),
  now(),
  now()
FROM payloads payload
WHERE payload.suitecrm_id IS NOT NULL
ON CONFLICT (target_system, idempotency_key)
WHERE idempotency_key IS NOT NULL
DO UPDATE SET
  payload = EXCLUDED.payload,
  status = CASE
    WHEN sync_outbox.status = 'processing' THEN sync_outbox.status
    ELSE 'queued'
  END,
  attempts = CASE
    WHEN sync_outbox.status = 'processing' THEN sync_outbox.attempts
    ELSE 0
  END,
  last_error = CASE
    WHEN sync_outbox.status = 'processing' THEN sync_outbox.last_error
    ELSE NULL
  END,
  available_at = CASE
    WHEN sync_outbox.status = 'processing' THEN sync_outbox.available_at
    ELSE now()
  END,
  processed_at = CASE
    WHEN sync_outbox.status = 'processing' THEN sync_outbox.processed_at
    ELSE NULL
  END,
  updated_at = now();

UPDATE crm_interactions
SET sync_status = 'pending',
    sync_error = NULL,
    updated_at = now()
WHERE suitecrm_id IS NOT NULL
  AND (
    suitecrm_module IN ('Calls', 'Meetings')
    OR suitecrm_module IS NULL
  );
