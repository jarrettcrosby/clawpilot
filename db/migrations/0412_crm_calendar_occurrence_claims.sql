-- An occurrence is a deduplication identity, not authority to edit a
-- Calendar. Keep every verified tuple when an explicit move changes it.
-- Existing meetings, mappings and cursors are not modified by this migration.
CREATE TABLE public.crm_calendar_occurrence_claims (
  pipeline_id uuid NOT NULL,
  occurrence_key text NOT NULL CHECK (occurrence_key ~ '^[0-9a-f]{64}$'),
  meeting_id uuid NOT NULL,
  PRIMARY KEY (pipeline_id, occurrence_key),
  UNIQUE (pipeline_id, occurrence_key, meeting_id),
  CONSTRAINT crm_calendar_occurrence_claim_meeting_fkey FOREIGN KEY (pipeline_id, meeting_id)
    REFERENCES public.crm_meetings(pipeline_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_crm_calendar_occurrence_claims_meeting
  ON public.crm_calendar_occurrence_claims(pipeline_id, meeting_id);

CREATE TABLE public.crm_calendar_occurrence_bindings (
  pipeline_id uuid NOT NULL,
  calendar_id text NOT NULL CHECK (length(calendar_id)<=1024 AND calendar_id COLLATE "C" ~ '^[!-~]+$' AND lower(calendar_id) <> 'primary'),
  external_event_id text NOT NULL CHECK (length(external_event_id)<=1000 AND external_event_id COLLATE "C" ~ '^[!-~]+$'),
  occurrence_key text NOT NULL,
  meeting_id uuid NOT NULL,
  PRIMARY KEY (pipeline_id, calendar_id, external_event_id),
  CONSTRAINT crm_calendar_occurrence_binding_claim_fkey FOREIGN KEY (pipeline_id, occurrence_key, meeting_id)
    REFERENCES public.crm_calendar_occurrence_claims(pipeline_id, occurrence_key, meeting_id) ON DELETE CASCADE
);
CREATE INDEX idx_crm_calendar_occurrence_bindings_claim
  ON public.crm_calendar_occurrence_bindings(pipeline_id, occurrence_key, meeting_id);

REVOKE ALL ON public.crm_calendar_occurrence_claims, public.crm_calendar_occurrence_bindings FROM PUBLIC;

CREATE FUNCTION public.clawpilot_crm_keep_calendar_occurrence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- A normal archive retains ownership. Allow the existing cascading hard
  -- deletion of a meeting/tenant only when the owning row is already gone.
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.crm_meetings m WHERE m.pipeline_id=OLD.pipeline_id AND m.id=OLD.meeting_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'Calendar occurrence ownership and verified bindings are immutable' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION public.clawpilot_crm_keep_calendar_occurrence() FROM PUBLIC;
CREATE TRIGGER crm_calendar_occurrence_claim_immutable BEFORE UPDATE OR DELETE ON public.crm_calendar_occurrence_claims
  FOR EACH ROW EXECUTE FUNCTION public.clawpilot_crm_keep_calendar_occurrence();
CREATE TRIGGER crm_calendar_occurrence_claim_no_truncate BEFORE TRUNCATE ON public.crm_calendar_occurrence_claims
  FOR EACH STATEMENT EXECUTE FUNCTION public.clawpilot_crm_keep_calendar_occurrence();
CREATE TRIGGER crm_calendar_occurrence_binding_immutable BEFORE UPDATE OR DELETE ON public.crm_calendar_occurrence_bindings
  FOR EACH ROW EXECUTE FUNCTION public.clawpilot_crm_keep_calendar_occurrence();
CREATE TRIGGER crm_calendar_occurrence_binding_no_truncate BEFORE TRUNCATE ON public.crm_calendar_occurrence_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION public.clawpilot_crm_keep_calendar_occurrence();

-- A running old discovery worker must not create an unkeyed meeting while a
-- new worker can claim the same invitation. Keep the mapping, claim, meeting
-- and its outbox write in one transaction; old existing rows can be hydrated.
CREATE FUNCTION public.clawpilot_crm_require_calendar_occurrence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.crm_calendar_occurrence_bindings b
    JOIN public.crm_calendar_discovery_events d
      ON d.pipeline_id=b.pipeline_id AND d.calendar_id=b.calendar_id
      AND d.external_event_id=b.external_event_id AND d.meeting_id=b.meeting_id
    WHERE b.pipeline_id=NEW.pipeline_id AND b.meeting_id=NEW.id
      AND b.calendar_id=NEW.source_payload->>'calendarId' AND b.external_event_id=NEW.external_event_id
  ) THEN
    RAISE EXCEPTION 'A new Calendar discovery meeting requires an exact occurrence claim and source binding' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.clawpilot_crm_require_calendar_occurrence() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER crm_calendar_discovery_occurrence_required
  AFTER INSERT ON public.crm_meetings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.source_key LIKE 'calendar-discovery:%' OR NEW.source_payload->>'source'='google_calendar_discovery')
  EXECUTE FUNCTION public.clawpilot_crm_require_calendar_occurrence();
