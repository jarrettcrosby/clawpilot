-- Project email-shaped CRM interactions into SuiteCRM's native Emails module.
-- Existing interaction history and stable SuiteCRM IDs are retained while the
-- legacy Note projection is replaced through the normal outbox worker.

ALTER TABLE crm_interactions
  DROP CONSTRAINT IF EXISTS crm_interactions_suitecrm_module_valid;

ALTER TABLE crm_interactions
  ADD CONSTRAINT crm_interactions_suitecrm_module_valid CHECK (
    suitecrm_module IS NULL OR suitecrm_module IN ('Notes', 'Calls', 'Meetings', 'Emails')
  );

-- Supersede queued legacy Note writes before scheduling the module transition.
DELETE FROM sync_outbox outbox
USING crm_interactions interaction
WHERE outbox.target_system = 'suitecrm'
  AND outbox.aggregate_type = 'crm_interactions'
  AND outbox.aggregate_id = interaction.id::text
  AND outbox.operation IN ('upsert_record', 'reproject_record')
  AND outbox.status IN ('queued', 'failed', 'dead')
  AND lower(btrim(COALESCE(interaction.interaction_type, ''))) = 'email'
  AND interaction.suitecrm_module IS DISTINCT FROM 'Emails';

WITH email_projection AS (
  SELECT
    interaction.*,
    organization.suitecrm_id AS organization_suitecrm_id,
    primary_contact.suitecrm_id AS contact_suitecrm_id,
    lead.suitecrm_id AS lead_suitecrm_id,
    opportunity.suitecrm_id AS opportunity_suitecrm_id,
    campaign.suitecrm_id AS campaign_suitecrm_id,
    app_user.suitecrm_user_id,
    COALESCE(NULLIF(interaction.suitecrm_module, 'Emails'), 'Notes') AS previous_suitecrm_module,
    CASE
      WHEN opportunity.suitecrm_id IS NOT NULL THEN 'Opportunities'
      WHEN primary_contact.suitecrm_id IS NOT NULL THEN 'Contacts'
      WHEN lead.suitecrm_id IS NOT NULL THEN 'Leads'
      WHEN organization.suitecrm_id IS NOT NULL THEN 'Accounts'
      WHEN campaign.suitecrm_id IS NOT NULL THEN 'Campaigns'
      ELSE NULL
    END AS parent_type,
    COALESCE(
      opportunity.suitecrm_id,
      primary_contact.suitecrm_id,
      lead.suitecrm_id,
      organization.suitecrm_id,
      campaign.suitecrm_id
    ) AS parent_id
  FROM crm_interactions interaction
  LEFT JOIN crm_organizations organization
    ON organization.pipeline_id = interaction.pipeline_id
   AND organization.id = interaction.organization_id
  LEFT JOIN crm_contacts primary_contact
    ON primary_contact.pipeline_id = interaction.pipeline_id
   AND primary_contact.id = interaction.contact_id
  LEFT JOIN crm_leads lead
    ON lead.pipeline_id = interaction.pipeline_id
   AND lead.id = interaction.lead_id
  LEFT JOIN crm_opportunities opportunity
    ON opportunity.pipeline_id = interaction.pipeline_id
   AND opportunity.id = interaction.opportunity_id
  LEFT JOIN crm_campaigns campaign
    ON campaign.pipeline_id = interaction.pipeline_id
   AND campaign.id = interaction.campaign_id
  LEFT JOIN app_users app_user
    ON app_user.email = interaction.agent_email
  WHERE lower(btrim(COALESCE(interaction.interaction_type, ''))) = 'email'
    AND interaction.suitecrm_module IS DISTINCT FROM 'Emails'
), payloads AS (
  SELECT
    email.*,
    jsonb_strip_nulls(jsonb_build_object(
      'entity', 'interactions',
      'pipelineId', email.pipeline_id::text,
      'localId', email.id::text,
      'suiteCrmId', email.suitecrm_id,
      'suiteCrmModule', 'Emails',
      'previousSuiteCrmModule', email.previous_suitecrm_module,
      'attributes', jsonb_strip_nulls(jsonb_build_object(
        'global_id_c', email.reference_code,
        'name', email.subject,
        'date_sent_received', to_char(email.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
        'type', 'archived',
        'status', CASE
          WHEN lower(COALESCE(email.direction, '')) = 'inbound'
            OR lower(COALESCE(email.delivery_status, '')) = 'received'
            THEN 'read'
          ELSE 'sent'
        END,
        'parent_type', email.parent_type,
        'parent_id', email.parent_id,
        'assigned_user_id', email.suitecrm_user_id,
        'description', COALESCE(email.description, ''),
        'description_html', ''
      )),
      'relationships', COALESCE((
        SELECT jsonb_agg(relationship ORDER BY sort_order, relationship->>'relatedBeanId')
        FROM (
          SELECT 0 AS sort_order, jsonb_build_object(
            'linkFieldName', 'accounts',
            'relatedModuleName', 'Accounts',
            'relatedBeanId', email.organization_suitecrm_id
          ) AS relationship
          WHERE email.organization_suitecrm_id IS NOT NULL
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
          WHERE selected.pipeline_id = email.pipeline_id
            AND selected.interaction_id = email.id
            AND contact.suitecrm_id IS NOT NULL
          UNION ALL
          SELECT 1000, jsonb_build_object(
            'linkFieldName', 'leads',
            'relatedModuleName', 'Leads',
            'relatedBeanId', email.lead_suitecrm_id
          )
          WHERE email.lead_suitecrm_id IS NOT NULL
        ) related
      ), '[]'::jsonb)
    )) AS payload
  FROM email_projection email
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
  'crm:interactions:email-module:v1:' || payload.id::text,
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
SET suitecrm_module = 'Emails',
    activity_status = NULL,
    duration_minutes = NULL,
    sync_status = 'pending',
    sync_error = NULL,
    updated_at = now()
WHERE lower(btrim(COALESCE(interaction_type, ''))) = 'email'
  AND suitecrm_module IS DISTINCT FROM 'Emails';
