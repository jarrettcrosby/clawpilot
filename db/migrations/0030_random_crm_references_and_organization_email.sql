-- CRM references are public identifiers, not row counters. Keep every allocation
-- forever so deleted or archived records cannot release a code for reuse.
CREATE TABLE IF NOT EXISTS crm_reference_registry (
  reference_code text PRIMARY KEY,
  prefix text NOT NULL,
  canonical_code text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  allocated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT crm_reference_registry_code_valid CHECK (reference_code ~ '^g[aciklmo][0-9]{7}$'),
  CONSTRAINT crm_reference_registry_prefix_valid CHECK (
    prefix IN ('ga', 'gc', 'gl', 'go', 'gm', 'gi', 'gk')
    AND prefix = left(reference_code, 2)
  ),
  CONSTRAINT crm_reference_registry_canonical_valid CHECK (canonical_code ~ '^g[aciklmo][0-9]{7}$'),
  CONSTRAINT crm_reference_registry_status_valid CHECK (status IN ('active', 'alias', 'retired'))
);

CREATE OR REPLACE FUNCTION allocate_crm_reference(requested_prefix text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  candidate text;
  allocated text;
BEGIN
  IF requested_prefix NOT IN ('ga', 'gc', 'gl', 'go', 'gm', 'gi', 'gk') THEN
    RAISE EXCEPTION 'Unsupported CRM reference prefix: %', requested_prefix;
  END IF;

  FOR attempt IN 1..1000 LOOP
    candidate := requested_prefix || (1000000 + floor(random() * 9000000)::bigint)::text;
    IF EXISTS (SELECT 1 FROM short_links WHERE slug = candidate) THEN
      CONTINUE;
    END IF;

    allocated := NULL;
    INSERT INTO crm_reference_registry (
      reference_code, prefix, canonical_code, status, allocated_at
    )
    VALUES (candidate, requested_prefix, candidate, 'active', now())
    ON CONFLICT (reference_code) DO NOTHING
    RETURNING reference_code INTO allocated;

    IF allocated IS NOT NULL THEN
      RETURN allocated;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'Unable to allocate a unique CRM reference for prefix %', requested_prefix;
END;
$$;

-- Reserve every value consumed by the old sequences, including values whose
-- records were subsequently deleted.
INSERT INTO crm_reference_registry (reference_code, prefix, canonical_code, status, allocated_at, retired_at)
SELECT code, left(code, 2), code, 'retired', now(), now()
FROM (
  SELECT 'ga' || lpad(value::text, 7, '0') AS code
  FROM generate_series(5999999, (SELECT last_value FROM crm_organization_reference_seq)) value
  UNION ALL
  SELECT 'gc' || lpad(value::text, 7, '0')
  FROM generate_series(5999999, (SELECT last_value FROM crm_contact_reference_seq)) value
  UNION ALL
  SELECT 'go' || lpad(value::text, 7, '0')
  FROM generate_series(5999999, (SELECT last_value FROM crm_opportunity_reference_seq)) value
  UNION ALL
  SELECT 'gi' || lpad(value::text, 7, '0')
  FROM generate_series(5999999, (SELECT last_value FROM crm_interaction_reference_seq)) value
  UNION ALL
  SELECT 'gl' || lpad(value::text, 7, '0')
  FROM generate_series(5999999, (SELECT last_value FROM crm_lead_reference_seq)) value
  UNION ALL
  SELECT 'gm' || lpad(value::text, 7, '0')
  FROM generate_series(5999999, (SELECT last_value FROM crm_meeting_reference_seq)) value
  UNION ALL
  SELECT 'gk' || lpad(value::text, 7, '0')
  FROM generate_series(5999999, (SELECT last_value FROM crm_campaign_reference_seq)) value
) reserved
ON CONFLICT (reference_code) DO NOTHING;

CREATE TEMP TABLE crm_reference_rekey ON COMMIT DROP AS
SELECT DISTINCT reference_code AS old_code, NULL::text AS new_code
FROM (
  SELECT reference_code FROM workspace_organizations
  UNION ALL SELECT reference_code FROM app_users
  UNION ALL SELECT reference_code FROM crm_organizations
  UNION ALL SELECT reference_code FROM crm_contacts
  UNION ALL SELECT reference_code FROM crm_leads
  UNION ALL SELECT reference_code FROM crm_opportunities
  UNION ALL SELECT reference_code FROM crm_meetings
  UNION ALL SELECT reference_code FROM crm_interactions
  UNION ALL SELECT reference_code FROM crm_campaigns
) current_references
WHERE reference_code ~ '^g[aciklmo][0-9]{7}$';

ALTER TABLE crm_reference_rekey
  ADD CONSTRAINT crm_reference_rekey_old_unique PRIMARY KEY (old_code),
  ADD CONSTRAINT crm_reference_rekey_new_unique UNIQUE (new_code);

INSERT INTO crm_reference_registry (reference_code, prefix, canonical_code, status, allocated_at, retired_at)
SELECT old_code, left(old_code, 2), old_code, 'retired', now(), now()
FROM crm_reference_rekey
ON CONFLICT (reference_code) DO NOTHING;

DO $$
DECLARE
  item record;
  replacement text;
BEGIN
  FOR item IN SELECT old_code FROM crm_reference_rekey ORDER BY old_code LOOP
    replacement := allocate_crm_reference(left(item.old_code, 2));
    UPDATE crm_reference_rekey SET new_code = replacement WHERE old_code = item.old_code;
    UPDATE crm_reference_registry
    SET canonical_code = replacement, status = 'alias', retired_at = now()
    WHERE reference_code = item.old_code;
  END LOOP;
END;
$$;

UPDATE workspace_organizations record
SET reference_code = mapping.new_code
FROM crm_reference_rekey mapping
WHERE record.reference_code = mapping.old_code;

UPDATE app_users record
SET reference_code = mapping.new_code
FROM crm_reference_rekey mapping
WHERE record.reference_code = mapping.old_code;

UPDATE crm_organizations record
SET reference_code = mapping.new_code
FROM crm_reference_rekey mapping
WHERE record.reference_code = mapping.old_code;

UPDATE crm_contacts record
SET reference_code = mapping.new_code
FROM crm_reference_rekey mapping
WHERE record.reference_code = mapping.old_code;

UPDATE crm_leads record
SET reference_code = mapping.new_code
FROM crm_reference_rekey mapping
WHERE record.reference_code = mapping.old_code;

UPDATE crm_opportunities record
SET reference_code = mapping.new_code
FROM crm_reference_rekey mapping
WHERE record.reference_code = mapping.old_code;

UPDATE crm_meetings record
SET reference_code = mapping.new_code
FROM crm_reference_rekey mapping
WHERE record.reference_code = mapping.old_code;

UPDATE crm_interactions record
SET reference_code = mapping.new_code
FROM crm_reference_rekey mapping
WHERE record.reference_code = mapping.old_code;

UPDATE crm_campaigns record
SET reference_code = mapping.new_code
FROM crm_reference_rekey mapping
WHERE record.reference_code = mapping.old_code;

UPDATE crm_integration_actions action
SET reference_code = mapping.new_code, updated_at = now()
FROM crm_reference_rekey mapping
WHERE action.reference_code = mapping.old_code;

UPDATE crm_inbound_message_links link
SET reference_code = mapping.new_code
FROM crm_reference_rekey mapping
WHERE link.reference_code = mapping.old_code;

UPDATE crm_inbound_messages message
SET marker_references = ARRAY(
  SELECT COALESCE(mapping.new_code, marker.reference_code)
  FROM unnest(message.marker_references) WITH ORDINALITY marker(reference_code, position)
  LEFT JOIN crm_reference_rekey mapping ON mapping.old_code = marker.reference_code
  ORDER BY marker.position
)
WHERE EXISTS (
  SELECT 1
  FROM unnest(message.marker_references) marker(reference_code)
  JOIN crm_reference_rekey mapping ON mapping.old_code = marker.reference_code
);

UPDATE crm_campaign_recipients recipient
SET merge_data = jsonb_set(merge_data, '{referenceCode}', to_jsonb(mapping.new_code), false),
    updated_at = now()
FROM crm_reference_rekey mapping
WHERE recipient.merge_data->>'referenceCode' = mapping.old_code;

UPDATE short_links link
SET destination_url = regexp_replace(
      link.destination_url,
      '/crm/' || mapping.old_code || '$',
      '/crm/' || mapping.new_code
    ),
    tags = array_append(array_replace(link.tags, mapping.old_code, mapping.new_code), 'legacy-alias-' || mapping.old_code),
    updated_at = now()
FROM crm_reference_rekey mapping
WHERE link.source_app = 'clawpilot-crm'
  AND link.slug = mapping.old_code;

ALTER TABLE crm_reference_registry
  ADD CONSTRAINT crm_reference_registry_canonical_fkey
  FOREIGN KEY (canonical_code) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION protect_crm_reference_registry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CRM reference allocations are immutable';
END;
$$;

CREATE TRIGGER protect_crm_reference_registry_delete
BEFORE DELETE ON crm_reference_registry
FOR EACH ROW EXECUTE FUNCTION protect_crm_reference_registry();

CREATE TRIGGER protect_crm_reference_registry_identity
BEFORE UPDATE OF reference_code, prefix, canonical_code ON crm_reference_registry
FOR EACH ROW EXECUTE FUNCTION protect_crm_reference_registry();

ALTER TABLE workspace_organizations
  ALTER COLUMN reference_code SET DEFAULT allocate_crm_reference('ga');
ALTER TABLE app_users
  ALTER COLUMN reference_code SET DEFAULT allocate_crm_reference('gc');
ALTER TABLE crm_organizations
  ALTER COLUMN reference_code SET DEFAULT allocate_crm_reference('ga');
ALTER TABLE crm_contacts
  ALTER COLUMN reference_code SET DEFAULT allocate_crm_reference('gc');
ALTER TABLE crm_leads
  ALTER COLUMN reference_code SET DEFAULT allocate_crm_reference('gl');
ALTER TABLE crm_opportunities
  ALTER COLUMN reference_code SET DEFAULT allocate_crm_reference('go');
ALTER TABLE crm_meetings
  ALTER COLUMN reference_code SET DEFAULT allocate_crm_reference('gm');
ALTER TABLE crm_interactions
  ALTER COLUMN reference_code SET DEFAULT allocate_crm_reference('gi');
ALTER TABLE crm_campaigns
  ALTER COLUMN reference_code SET DEFAULT allocate_crm_reference('gk');

DROP SEQUENCE IF EXISTS crm_organization_reference_seq;
DROP SEQUENCE IF EXISTS crm_contact_reference_seq;
DROP SEQUENCE IF EXISTS crm_opportunity_reference_seq;
DROP SEQUENCE IF EXISTS crm_interaction_reference_seq;
DROP SEQUENCE IF EXISTS crm_lead_reference_seq;
DROP SEQUENCE IF EXISTS crm_meeting_reference_seq;
DROP SEQUENCE IF EXISTS crm_campaign_reference_seq;

ALTER TABLE crm_organizations
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS email_opt_out boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_crm_reference_registry_canonical
  ON crm_reference_registry (canonical_code, status, reference_code);
