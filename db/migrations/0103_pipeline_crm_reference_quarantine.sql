ALTER TABLE pipeline_spaces
  ADD COLUMN IF NOT EXISTS reference_access_disabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pipeline_spaces.reference_access_disabled IS
  'When true, the quarantined pipeline cannot be joined, selected as a workspace default, or exposed through public CRM references.';

CREATE OR REPLACE FUNCTION reject_reference_disabled_pipeline_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  access_disabled boolean;
BEGIN
  SELECT pipeline.reference_access_disabled
  INTO access_disabled
  FROM pipeline_spaces pipeline
  WHERE pipeline.id = NEW.pipeline_id
  FOR SHARE;

  IF access_disabled THEN
    RAISE EXCEPTION 'Quarantined pipelines cannot receive workspace memberships'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reject_reference_disabled_pipeline_membership
  ON pipeline_space_members;
CREATE TRIGGER trg_reject_reference_disabled_pipeline_membership
BEFORE INSERT OR UPDATE OF pipeline_id ON pipeline_space_members
FOR EACH ROW EXECUTE FUNCTION reject_reference_disabled_pipeline_membership();

CREATE OR REPLACE FUNCTION reject_reference_disabled_pipeline_preference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  access_disabled boolean;
BEGIN
  IF NEW.default_pipeline_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT pipeline.reference_access_disabled
  INTO access_disabled
  FROM pipeline_spaces pipeline
  WHERE pipeline.id = NEW.default_pipeline_id
  FOR SHARE;

  IF access_disabled THEN
    RAISE EXCEPTION 'Quarantined pipelines cannot be selected as workspace defaults'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reject_reference_disabled_pipeline_preference
  ON app_user_workspace_preferences;
CREATE TRIGGER trg_reject_reference_disabled_pipeline_preference
BEFORE INSERT OR UPDATE OF default_pipeline_id ON app_user_workspace_preferences
FOR EACH ROW EXECUTE FUNCTION reject_reference_disabled_pipeline_preference();

CREATE OR REPLACE FUNCTION require_pipeline_access_removed_before_quarantine()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.reference_access_disabled
    AND NOT OLD.reference_access_disabled
    AND (
      EXISTS (
        SELECT 1
        FROM pipeline_space_members membership
        WHERE membership.pipeline_id = NEW.id
      )
      OR EXISTS (
        SELECT 1
        FROM app_user_workspace_preferences preference
        WHERE preference.default_pipeline_id = NEW.id
      )
    )
  THEN
    RAISE EXCEPTION 'Pipeline memberships and defaults must be removed before quarantine'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_require_pipeline_access_removed_before_quarantine
  ON pipeline_spaces;
CREATE TRIGGER trg_require_pipeline_access_removed_before_quarantine
BEFORE UPDATE OF reference_access_disabled ON pipeline_spaces
FOR EACH ROW EXECUTE FUNCTION require_pipeline_access_removed_before_quarantine();

CREATE OR REPLACE FUNCTION preserve_quarantined_pipeline_short_link_disable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  access_disabled boolean;
BEGIN
  IF NEW.deleted_at IS NOT NULL
    OR NEW.disabled_at IS NOT NULL
    OR NEW.source_app <> 'clawpilot-crm'
  THEN
    RETURN NEW;
  END IF;

  FOR access_disabled IN
    WITH candidate_references AS (
      SELECT lower(candidate.reference_code) AS reference_code
      FROM unnest(
        COALESCE(NEW.tags, ARRAY[]::text[])
        || ARRAY[
          CASE
            WHEN lower(NEW.slug) ~ '^g[aciklmop][0-9]{7}$'
              THEN lower(NEW.slug)
            WHEN lower(NEW.slug) ~ '^mail-g[aciklmop][0-9]{7}$'
              THEN substring(lower(NEW.slug) FROM 6)
            ELSE NULL
          END,
          (regexp_match(
            lower(NEW.destination_url),
            '/crm/(g[aciklmop][0-9]{7})'
          ))[1]
        ]
      ) AS candidate(reference_code)
      WHERE candidate.reference_code ~ '^g[aciklmop][0-9]{7}$'
    ), reference_pipelines AS (
      SELECT pipeline_id, reference_code FROM crm_organizations
      UNION ALL
      SELECT pipeline_id, reference_code FROM crm_contacts
      UNION ALL
      SELECT pipeline_id, reference_code FROM crm_leads
      UNION ALL
      SELECT pipeline_id, reference_code FROM crm_products
      UNION ALL
      SELECT pipeline_id, reference_code FROM crm_opportunities
      UNION ALL
      SELECT pipeline_id, reference_code FROM crm_interactions
      UNION ALL
      SELECT pipeline_id, reference_code FROM crm_meetings
      UNION ALL
      SELECT pipeline_id, reference_code FROM crm_campaigns
      UNION ALL
      SELECT pipeline_id, survivor_reference_code FROM crm_contact_merges
      UNION ALL
      SELECT pipeline_id, duplicate_reference_code FROM crm_contact_merges
      UNION ALL
      SELECT contact.pipeline_id, alias.alias_code
      FROM crm_reference_aliases alias
      JOIN crm_contacts contact
        ON contact.reference_code = alias.canonical_code
    )
    SELECT pipeline.reference_access_disabled
    FROM pipeline_spaces pipeline
    JOIN reference_pipelines reference
      ON reference.pipeline_id = pipeline.id
    JOIN candidate_references candidate
      ON candidate.reference_code = reference.reference_code
    FOR SHARE OF pipeline
  LOOP
    IF access_disabled THEN
      NEW.disabled_at = CASE
        WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.disabled_at, now())
        ELSE now()
      END;
      RETURN NEW;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_preserve_quarantined_pipeline_short_link_disable
  ON short_links;
CREATE TRIGGER trg_preserve_quarantined_pipeline_short_link_disable
BEFORE INSERT OR UPDATE OF
  source_app, slug, destination_url, tags, disabled_at, deleted_at
ON short_links
FOR EACH ROW EXECUTE FUNCTION preserve_quarantined_pipeline_short_link_disable();
