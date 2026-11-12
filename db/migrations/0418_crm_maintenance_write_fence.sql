-- Independent CRM write admission for an attended maintenance window. The
-- migration installs the fence OPEN. No app route can activate or clear it.
-- Never hold the serving deployment behind an unbounded DDL lock queue.
SET LOCAL lock_timeout = '4s';
CREATE SCHEMA clawpilot_crm_maintenance;
REVOKE ALL ON SCHEMA clawpilot_crm_maintenance FROM PUBLIC;

CREATE TABLE clawpilot_crm_maintenance.write_fence (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  fence_id uuid,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO clawpilot_crm_maintenance.write_fence (singleton) VALUES (true);
REVOKE ALL ON TABLE clawpilot_crm_maintenance.write_fence FROM PUBLIC;

CREATE FUNCTION clawpilot_crm_maintenance.admit_write() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE active_fence uuid;
BEGIN
  -- Retain the shared lock until commit/rollback, including after the statement.
  -- The operator's conflicting UPDATE cannot complete before admitted writers
  -- drain; old repeatable-read snapshots fail instead of reading a stale flag.
  SELECT fence_id INTO active_fence
  FROM clawpilot_crm_maintenance.write_fence WHERE singleton FOR SHARE;
  IF NOT FOUND OR active_fence IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'CRM writes are temporarily paused for maintenance';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_maintenance.admit_write() FROM PUBLIC;

CREATE FUNCTION clawpilot_crm_maintenance.check_relation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM clawpilot_crm_maintenance.admit_write();
  RETURN NULL; -- statement trigger
END;
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_maintenance.check_relation() FROM PUBLIC;

-- Mixed-use relations are guarded by the actual row, on both sides of an
-- update, so CRM rows cannot be retargeted to evade the fence.
CREATE FUNCTION clawpilot_crm_maintenance.is_crm_row(relation_name text, row_data jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
  SELECT CASE relation_name
    WHEN 'sync_outbox' THEN
      lower(coalesce(row_data->>'target_system','')) = 'suitecrm'
      OR lower(coalesce(row_data->>'aggregate_type','')) ~ '^(crm_|crm\.|fractional_crm_)'
      OR (coalesce(row_data->>'aggregate_type','') LIKE 'pipeline%' AND row_data->>'operation' IN (
        'project_crm_workbook','sync_pipeline_owner_profile_v1','append_interaction','update_opportunity',
        'provision_pipeline','reconcile_pipeline_hierarchy_v2','reconcile_pipeline_hierarchy_v3',
        'reconcile_pipeline_hierarchy_v4','reconcile_pipeline_hierarchy_v5','reconcile_pipeline_hierarchy_v6'))
    WHEN 'sync_jobs' THEN
      lower(coalesce(row_data->>'source_system','')) = 'suitecrm'
      OR lower(coalesce(row_data->>'target_system','')) = 'suitecrm'
    WHEN 'short_links' THEN row_data->>'source_app' = 'clawpilot-crm'
    WHEN 'short_link_clicks' THEN row_data->>'source_app' = 'clawpilot-crm'
    WHEN 'app_settings' THEN lower(coalesce(row_data->>'key','')) LIKE 'crm.%'
    WHEN 'audit_events' THEN
      lower(coalesce(row_data->>'event_type','')) ~ '^(crm\.|crm_|fractional_crm\.|fractional_crm_)'
      OR lower(coalesce(row_data->>'aggregate_type','')) ~ '^(crm_|crm\.|fractional_crm_)'
    WHEN 'crm_reference_registry' THEN lower(coalesce(row_data->>'entity_type','')) LIKE 'crm.%'
    WHEN 'pipeline_spaces' THEN row_data->>'crm_last_synced_at' IS NOT NULL
    WHEN 'organization_quickbooks_connections' THEN
      row_data->>'crm_pipeline_id' IS NOT NULL OR row_data->>'crm_customer_sync_enabled' = 'true'
      OR row_data->>'crm_product_sync_enabled' = 'true' OR row_data->>'last_crm_synced_at' IS NOT NULL
      OR row_data->>'last_crm_sync_error' IS NOT NULL
    WHEN 'app_users' THEN row_data->>'crm_user_enabled' = 'true'
      OR row_data->>'suitecrm_user_id' IS NOT NULL OR row_data->>'suitecrm_username' IS NOT NULL
    ELSE true -- no permissive fall-through for an unexpected trigger attachment
  END;
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_maintenance.is_crm_row(text, jsonb) FROM PUBLIC;

CREATE FUNCTION clawpilot_crm_maintenance.check_mixed_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE previous_row jsonb;
DECLARE next_row jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN next_row := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'pipeline_spaces' AND TG_OP = 'UPDATE' THEN
    IF EXISTS (
      SELECT FROM unnest(ARRAY['crm_last_synced_at','workspace_organization_id','owner_email',
        'crm_provider','crm_projection_version']) AS k(key)
      WHERE previous_row->k.key IS DISTINCT FROM next_row->k.key
    ) THEN PERFORM clawpilot_crm_maintenance.admit_write(); END IF;
  ELSIF TG_TABLE_NAME = 'organization_quickbooks_connections' AND TG_OP = 'UPDATE' THEN
    IF EXISTS (
      SELECT FROM unnest(ARRAY['crm_pipeline_id','crm_customer_sync_enabled','crm_product_sync_enabled',
        'last_crm_synced_at','last_crm_sync_error']) AS k(key)
      WHERE previous_row->k.key IS DISTINCT FROM next_row->k.key
    ) THEN PERFORM clawpilot_crm_maintenance.admit_write(); END IF;
  ELSIF TG_TABLE_NAME = 'app_users' AND TG_OP = 'UPDATE' THEN
    IF EXISTS (
      SELECT FROM unnest(ARRAY['crm_user_enabled','suitecrm_user_id','suitecrm_username']) AS k(key)
      WHERE previous_row->k.key IS DISTINCT FROM next_row->k.key
    ) OR ((clawpilot_crm_maintenance.is_crm_row(TG_TABLE_NAME,previous_row)
      OR clawpilot_crm_maintenance.is_crm_row(TG_TABLE_NAME,next_row)) AND EXISTS (
      SELECT FROM unnest(ARRAY['email','status','role','permissions','organization_id','reference_code']) AS k(key)
      WHERE previous_row->k.key IS DISTINCT FROM next_row->k.key
    )) THEN PERFORM clawpilot_crm_maintenance.admit_write(); END IF;
  ELSIF clawpilot_crm_maintenance.is_crm_row(TG_TABLE_NAME, previous_row)
     OR clawpilot_crm_maintenance.is_crm_row(TG_TABLE_NAME, next_row) THEN
    PERFORM clawpilot_crm_maintenance.admit_write();
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_maintenance.check_mixed_row() FROM PUBLIC;

CREATE FUNCTION clawpilot_crm_maintenance.mixed_relations() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY['sync_outbox','sync_jobs','short_links','short_link_clicks','app_settings',
    'audit_events','crm_reference_registry','pipeline_spaces','organization_quickbooks_connections','app_users']::text[];
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_maintenance.mixed_relations() FROM PUBLIC;

CREATE FUNCTION clawpilot_crm_maintenance.scope()
RETURNS TABLE(schema_name text, relation_name text, relation_oid oid, mixed boolean, unsupported boolean)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT n.nspname::text,c.relname::text,c.oid,
    n.nspname='public' AND c.relname::text=ANY(clawpilot_crm_maintenance.mixed_relations()),
    c.relkind <> 'r' OR EXISTS (SELECT FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p','f') AND (
    (n.nspname='public' AND (
      c.relname::text=ANY(clawpilot_crm_maintenance.mixed_relations())
      OR c.relname IN ('quickbooks_crm_links','pipeline_space_members')
      OR (c.relname::text ~ '^(crm_|fractional_crm_)' AND c.relname<>'crm_reference_number_registry')
    )) OR n.nspname IN ('crm_legacy_email_retirement','crm_legacy_email_terminal_hold')
  );
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_maintenance.scope() FROM PUBLIC;

-- Install an ALWAYS trigger (including replication role) at each current CRM
-- relation; no inherited/partitioned/foreign relation may silently evade it.
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM clawpilot_crm_maintenance.scope() ORDER BY schema_name,relation_name LOOP
    IF item.unsupported THEN RAISE EXCEPTION 'Unsupported CRM maintenance table topology'; END IF;
    IF item.mixed THEN
      EXECUTE format('CREATE TRIGGER clawpilot_crm_fence_write BEFORE INSERT OR UPDATE OR DELETE ON %I.%I '
        'FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_maintenance.check_mixed_row()',item.schema_name,item.relation_name);
      EXECUTE format('CREATE TRIGGER clawpilot_crm_fence_truncate BEFORE TRUNCATE ON %I.%I '
        'FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_maintenance.check_relation()',item.schema_name,item.relation_name);
      EXECUTE format('ALTER TABLE %I.%I ENABLE ALWAYS TRIGGER clawpilot_crm_fence_truncate',item.schema_name,item.relation_name);
    ELSE
      EXECUTE format('CREATE TRIGGER clawpilot_crm_fence_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I.%I '
        'FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_maintenance.check_relation()',item.schema_name,item.relation_name);
    END IF;
    EXECUTE format('ALTER TABLE %I.%I ENABLE ALWAYS TRIGGER clawpilot_crm_fence_write',item.schema_name,item.relation_name);
  END LOOP;
END;
$$;

CREATE FUNCTION clawpilot_crm_maintenance.coverage() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT (SELECT count(*) FROM clawpilot_crm_maintenance.scope() WHERE mixed)
           = cardinality(clawpilot_crm_maintenance.mixed_relations())
    AND EXISTS (SELECT FROM clawpilot_crm_maintenance.scope() WHERE schema_name='public' AND relation_name='crm_interactions')
    AND EXISTS (SELECT FROM clawpilot_crm_maintenance.scope() WHERE schema_name='public' AND relation_name='quickbooks_crm_links')
    AND EXISTS (SELECT FROM clawpilot_crm_maintenance.scope() WHERE schema_name='public' AND relation_name='pipeline_space_members')
    AND EXISTS (SELECT FROM clawpilot_crm_maintenance.scope() WHERE schema_name='crm_legacy_email_retirement')
    AND EXISTS (SELECT FROM clawpilot_crm_maintenance.scope() WHERE schema_name='crm_legacy_email_terminal_hold')
    AND NOT EXISTS (
      SELECT FROM (VALUES
        ('sync_outbox',ARRAY['target_system','aggregate_type','operation']),
        ('sync_jobs',ARRAY['source_system','target_system']),
        ('short_links',ARRAY['source_app']), ('short_link_clicks',ARRAY['source_app']),
        ('app_settings',ARRAY['key']), ('audit_events',ARRAY['event_type','aggregate_type']),
        ('crm_reference_registry',ARRAY['entity_type']), ('pipeline_spaces',ARRAY['crm_last_synced_at',
          'workspace_organization_id','owner_email','crm_provider','crm_projection_version']),
        ('organization_quickbooks_connections',ARRAY['crm_pipeline_id','crm_customer_sync_enabled',
          'crm_product_sync_enabled','last_crm_synced_at','last_crm_sync_error']),
        ('app_users',ARRAY['crm_user_enabled','suitecrm_user_id','suitecrm_username','email','status','role',
          'permissions','organization_id','reference_code'])
      ) AS needed(relation,columns) CROSS JOIN LATERAL unnest(needed.columns) AS col(name)
      WHERE NOT EXISTS (
        SELECT FROM clawpilot_crm_maintenance.scope() s JOIN pg_attribute a ON a.attrelid=s.relation_oid
        WHERE s.schema_name='public' AND s.relation_name=needed.relation
          AND a.attname=col.name AND a.attnum>0 AND NOT a.attisdropped
      )
    )
    AND NOT EXISTS (
      SELECT FROM clawpilot_crm_maintenance.scope() s WHERE s.unsupported OR NOT EXISTS (
        SELECT FROM pg_trigger t WHERE t.tgrelid=s.relation_oid AND t.tgname='clawpilot_crm_fence_write'
          AND t.tgenabled='A' AND NOT t.tgisinternal AND t.tgqual IS NULL
          AND ((s.mixed AND t.tgtype=31 AND t.tgfoid='clawpilot_crm_maintenance.check_mixed_row()'::regprocedure)
            OR (NOT s.mixed AND t.tgtype=62 AND t.tgfoid='clawpilot_crm_maintenance.check_relation()'::regprocedure))
      ) OR (s.mixed AND NOT EXISTS (
        SELECT FROM pg_trigger t WHERE t.tgrelid=s.relation_oid AND t.tgname='clawpilot_crm_fence_truncate'
          AND t.tgenabled='A' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgtype=34
          AND t.tgfoid='clawpilot_crm_maintenance.check_relation()'::regprocedure
      ))
    );
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_maintenance.coverage() FROM PUBLIC;

-- Only the reviewed migration/operator role may call this function. Activate
-- in a dedicated short transaction (with a bounded lock/statement timeout);
-- commit before snapshot or upgrade. Clear with the same attempt ID only.
CREATE FUNCTION clawpilot_crm_maintenance.transition(expected uuid, replacement uuid) RETURNS timestamptz
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE transitioned_at timestamptz;
BEGIN
  IF (expected IS NULL) = (replacement IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='A CRM fence transition must activate or clear one attempt';
  END IF;
  IF replacement IS NOT NULL AND NOT clawpilot_crm_maintenance.coverage() THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CRM maintenance trigger coverage is not verified';
  END IF;
  UPDATE clawpilot_crm_maintenance.write_fence SET fence_id=replacement,changed_at=clock_timestamp()
    WHERE singleton AND fence_id IS NOT DISTINCT FROM expected RETURNING changed_at INTO transitioned_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CRM maintenance fence attempt changed or is unavailable';
  END IF;
  RETURN transitioned_at;
END;
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_maintenance.transition(uuid, uuid) FROM PUBLIC;

DO $$ BEGIN
  IF NOT clawpilot_crm_maintenance.coverage() THEN
    RAISE EXCEPTION 'Cannot install CRM maintenance fence with incomplete trigger coverage';
  END IF;
END; $$;
