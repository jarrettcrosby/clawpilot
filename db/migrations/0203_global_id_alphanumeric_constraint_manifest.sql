-- Generated from the development catalog on 2026-08-01 by
-- scripts/inspect-global-id-postgres-catalog.mjs --sql-values.
-- The exact manifest makes catalog drift fail closed instead of silently
-- leaving a numeric-only Global ID boundary active.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

CREATE TABLE global_id_compatibility_constraint_manifest (
  ordinal integer PRIMARY KEY,
  table_name text NOT NULL,
  constraint_name text NOT NULL,
  expanded_at timestamptz,
  CONSTRAINT global_id_compatibility_constraint_manifest_unique
    UNIQUE (table_name, constraint_name)
);

INSERT INTO global_id_compatibility_constraint_manifest (
  ordinal,
  table_name,
  constraint_name
)
SELECT
  row_number() OVER (ORDER BY source.table_name, source.constraint_name)::integer,
  source.table_name,
  source.constraint_name
FROM (VALUES
  ('app_users', 'app_users_contact_reference_code_valid'),
  ('app_users', 'app_users_crm_employee_identity_complete'),
  ('app_users', 'app_users_reference_code_valid'),
  ('crm_board_cards', 'crm_board_cards_reference_code_check'),
  ('crm_campaigns', 'crm_campaigns_reference_code_valid'),
  ('crm_contact_merges', 'crm_contact_merges_duplicate_reference_valid'),
  ('crm_contact_merges', 'crm_contact_merges_survivor_reference_valid'),
  ('crm_contacts', 'crm_contacts_owner_user_reference_code_valid'),
  ('crm_contacts', 'crm_contacts_reference_code_valid'),
  ('crm_inbound_message_links', 'crm_inbound_message_links_reference_valid'),
  ('crm_interactions', 'crm_interactions_reference_code_valid'),
  ('crm_leads', 'crm_leads_reference_code_valid'),
  ('crm_meetings', 'crm_meetings_reference_code_valid'),
  ('crm_opportunities', 'crm_opportunities_reference_code_valid'),
  ('crm_organizations', 'crm_organizations_reference_code_valid'),
  ('crm_product_identity_aliases', 'crm_product_identity_aliases_global_valid'),
  ('crm_products', 'crm_products_reference_code_valid'),
  ('crm_reference_aliases', 'crm_reference_aliases_alias_valid'),
  ('crm_reference_aliases', 'crm_reference_aliases_canonical_valid'),
  ('crm_reference_registry', 'crm_reference_registry_canonical_valid'),
  ('crm_reference_registry', 'crm_reference_registry_code_valid'),
  ('operations_active_carrier_group_attempts', 'operations_active_carrier_group_attempts_global_valid'),
  ('operations_active_carrier_package_results', 'operations_active_carrier_package_results_global_valid'),
  ('operations_active_fulfillment_executions', 'operations_active_fulfillment_executions_global_valid'),
  ('operations_active_shipment_groups', 'operations_active_shipment_groups_global_valid'),
  ('operations_approved_pack_recipes', 'operations_approved_pack_recipes_global_valid'),
  ('operations_billable_events', 'operations_billable_events_global_valid'),
  ('operations_carrier_account_authorizations', 'operations_carrier_account_authorizations_global_valid'),
  ('operations_carrier_accounts', 'operations_carrier_accounts_global_valid'),
  ('operations_carrier_billing_account_resolutions', 'operations_carrier_billing_account_resolutions_global_valid'),
  ('operations_carrier_billing_batches', 'operations_carrier_billing_batches_global_valid'),
  ('operations_carrier_billing_charges', 'operations_carrier_billing_charges_global_valid'),
  ('operations_carrier_billing_import_rows', 'operations_carrier_billing_import_rows_global_valid'),
  ('operations_carrier_billing_matches', 'operations_carrier_billing_matches_global_valid'),
  ('operations_carrier_billing_mud_calculations', 'operations_carrier_billing_mud_global_valid'),
  ('operations_carrier_billing_reconciliations', 'operations_carrier_billing_reconciliations_global_valid'),
  ('operations_carrier_billing_routing_rules', 'operations_carrier_billing_routing_rules_global_valid'),
  ('operations_carrier_billing_shipper_assignments', 'operations_carrier_billing_shipper_assignments_global_valid'),
  ('operations_carrier_billing_statements', 'operations_carrier_billing_statements_global_valid'),
  ('operations_carrier_quote_snapshots', 'operations_carrier_quote_snapshots_global_valid'),
  ('operations_carrier_rate_directives', 'operations_carrier_rate_directives_global_valid'),
  ('operations_carrier_rate_grants', 'operations_carrier_rate_grants_global_valid'),
  ('operations_carrier_rate_grant_users', 'operations_carrier_rate_grant_users_global_valid'),
  ('operations_carrier_rate_networks', 'operations_carrier_rate_networks_global_valid'),
  ('operations_carrier_rate_parties', 'operations_carrier_rate_parties_global_valid'),
  ('operations_carrier_rate_requests', 'operations_carrier_rate_requests_global_valid'),
  ('operations_carrier_rates', 'operations_carrier_rates_global_valid'),
  ('operations_carrier_rate_test_label_attempts', 'operations_carrier_rate_test_label_attempts_global_valid'),
  ('operations_carrier_rate_test_label_derivatives', 'operations_carrier_rate_test_label_derivatives_global_valid'),
  ('operations_carrier_rate_test_labels', 'operations_carrier_rate_test_labels_global_valid'),
  ('operations_cartonization_rate_evidence', 'operations_cartonization_rate_evidence_global_valid'),
  ('operations_cartonization_rate_evidence_package_recipes', 'operations_cartonization_rat_input_profile_version_global_check'),
  ('operations_cartonization_rate_evidence_package_recipes', 'operations_cartonization_rate_evidence__product_global_id_check'),
  ('operations_cartonization_rate_evidence_package_recipes', 'operations_cartonization_rate_evidence_p_recipe_global_id_check'),
  ('operations_carton_plans', 'operations_carton_plans_global_valid'),
  ('operations_commerce_active_transition_authorizations', 'ops_commerce_active_auth_global_valid'),
  ('operations_commerce_active_transition_preparations', 'ops_commerce_active_prep_global_valid'),
  ('operations_commerce_active_transitions', 'ops_commerce_active_transition_global_valid'),
  ('operations_commerce_catalog_sync_jobs', 'operations_commerce_catalog_sy_continuation_run_global_id_check'),
  ('operations_commerce_external_effect_intents', 'operations_commerce_external_effect_intents_global_valid'),
  ('operations_commerce_fulfillment_exports', 'operations_commerce_fulfillment_exports_global_valid'),
  ('operations_commerce_intake_read_intents', 'commerce_intake_read_intents_target_valid'),
  ('operations_commerce_intake_rejections', 'commerce_intake_rejections_global_valid'),
  ('operations_commerce_intake_runs', 'commerce_intake_runs_global_valid'),
  ('operations_commerce_inventory_captures', 'operations_commerce_inventory_captures_global_valid'),
  ('operations_commerce_inventory_levels', 'operations_commerce_inventory_levels_global_valid'),
  ('operations_commerce_inventory_location_mappings', 'operations_commerce_inventory_location_mappings_global_valid'),
  ('operations_commerce_inventory_sync_runs', 'operations_commerce_inventory_sync_runs_global_valid'),
  ('operations_commerce_order_candidate_lines', 'commerce_order_lines_global_valid'),
  ('operations_commerce_order_candidates', 'commerce_order_candidates_global_valid'),
  ('operations_commerce_product_candidates', 'commerce_product_candidates_global_valid'),
  ('operations_commerce_provider_attempts', 'operations_commerce_provider_attempts_global_valid'),
  ('operations_commerce_resolution_decisions', 'commerce_resolution_decisions_global_valid'),
  ('operations_commerce_variant_pack_mappings', 'operations_commerce_variant_pack_mappings_global_valid'),
  ('operations_commerce_webhook_receipts', 'operations_commerce_webhook_receipts_global_valid'),
  ('operations_contracts', 'operations_contracts_global_valid'),
  ('operations_contract_versions', 'operations_contract_versions_global_valid'),
  ('operations_domain_events', 'operations_domain_events_global_valid'),
  ('operations_exceptions', 'operations_exceptions_global_valid'),
  ('operations_fulfillment_allocations', 'operations_fulfillment_allocations_global_valid'),
  ('operations_fulfillment_executions', 'operations_fulfillment_executions_global_valid'),
  ('operations_fulfillment_plans', 'operations_fulfillment_plans_global_valid'),
  ('operations_gl_coding_review_items', 'operations_gl_coding_review_items_global_valid'),
  ('operations_gl_coding_reviews', 'operations_gl_coding_reviews_global_valid'),
  ('operations_gl_coding_run_items', 'operations_gl_coding_run_items_global_valid'),
  ('operations_gl_coding_runs', 'operations_gl_coding_runs_global_valid'),
  ('operations_integration_accounts', 'operations_integration_accounts_global_valid'),
  ('operations_inventory_ledger', 'operations_inventory_ledger_global_valid'),
  ('operations_inventory_pools', 'operations_inventory_pools_global_valid'),
  ('operations_inventory_positions', 'operations_inventory_positions_global_valid'),
  ('operations_label_attempts', 'operations_label_attempts_global_valid'),
  ('operations_labels', 'operations_labels_global_valid'),
  ('operations_location_product_rules', 'operations_location_product_rules_global_valid'),
  ('operations_locations', 'operations_locations_global_valid'),
  ('operations_order_lines', 'operations_order_lines_global_valid'),
  ('operations_orders', 'operations_orders_global_valid'),
  ('operations_package_contents', 'operations_package_contents_global_valid'),
  ('operations_packages', 'operations_packages_global_valid'),
  ('operations_packaging_material_claims', 'ops_packaging_claim_global_valid'),
  ('operations_packaging_materials', 'operations_packaging_materials_global_valid'),
  ('operations_packaging_material_stock', 'operations_packaging_material_stock_global_valid'),
  ('operations_pack_rate_runs', 'operations_pack_rate_runs_global_valid'),
  ('operations_pack_rate_variances', 'operations_pack_rate_variances_global_valid'),
  ('operations_pick_tasks', 'operations_pick_tasks_global_valid'),
  ('operations_pricing_directives', 'operations_pricing_directives_global_valid'),
  ('operations_print_agents', 'operations_print_agents_global_valid'),
  ('operations_print_artifacts', 'operations_print_artifacts_global_valid'),
  ('operations_printers', 'operations_printers_global_valid'),
  ('operations_print_jobs', 'operations_print_jobs_global_valid'),
  ('operations_product_channel_states', 'operations_product_channel_states_global_valid'),
  ('operations_production_fulfillment_rerate_attempts', 'operations_production_rerate_attempts_global_valid'),
  ('operations_production_fulfillment_rerate_offers', 'operations_production_rerate_offers_global_valid'),
  ('operations_production_fulfillment_rerate_packages', 'operations_production_rerate_packages_global_valid'),
  ('operations_production_fulfillment_rerate_packages', 'operations_production_rerate_packages_text_valid'),
  ('operations_production_fulfillment_rerate_results', 'operations_production_rerate_results_global_valid'),
  ('operations_production_fulfillment_rerate_runs', 'operations_production_rerate_runs_global_valid'),
  ('operations_production_fulfillment_rerate_selections', 'operations_production_rerate_selections_global_valid'),
  ('operations_product_mappings', 'operations_product_mappings_global_valid'),
  ('operations_product_package_profiles', 'operations_product_package_profiles_global_valid'),
  ('operations_product_pack_profiles', 'operations_product_pack_profiles_global_valid'),
  ('operations_product_pack_profile_versions', 'operations_product_pack_profile_versions_global_valid'),
  ('operations_product_pack_relationships', 'operations_product_pack_relationships_global_valid'),
  ('operations_receipt_lines', 'operations_receipt_lines_global_valid'),
  ('operations_receipts', 'operations_receipts_global_valid'),
  ('operations_replenishment_tasks', 'operations_replenishment_tasks_global_valid'),
  ('operations_reservations', 'operations_reservations_global_valid'),
  ('operations_rules', 'operations_rules_global_valid'),
  ('operations_sandbox_commerce_e2e_authorizations', 'operations_sandbox_commerce_e2e_authorizations_global_valid'),
  ('operations_settlement_entries', 'operations_settlement_entries_global_valid'),
  ('operations_settlement_events', 'operations_settlement_events_global_valid'),
  ('operations_shipment_groups', 'operations_shipment_groups_global_valid'),
  ('operations_shipments', 'operations_shipments_global_valid'),
  ('operations_shopify_carrier_service_config_mutation_links', 'ops_shopify_cs_config_mut_link_global_valid'),
  ('operations_shopify_carrier_service_configs', 'operations_shopify_carrier_service_configs_global_valid'),
  ('operations_shopify_carrier_service_mutation_attempts', 'ops_shopify_cs_mut_attempt_global_valid'),
  ('operations_shopify_carrier_service_mutation_authorizations', 'ops_shopify_cs_mut_auth_global_valid'),
  ('operations_shopify_carrier_service_mutation_outcomes', 'ops_shopify_cs_mut_outcome_global_valid'),
  ('operations_shopify_carrier_service_mutation_resolutions', 'ops_shopify_cs_mut_resolution_global_valid'),
  ('operations_shopify_checkout_rate_receipts', 'operations_shopify_checkout_rate_receipts_global_valid'),
  ('operations_shopify_checkout_rate_reconciliations', 'operations_shopify_checkout_rate_reconciliations_global_valid'),
  ('operations_shopify_checkout_rate_reconciliation_supersessions', 'ops_shopify_rate_recon_supersession_global_valid'),
  ('operations_shopify_customer_rate_policies', 'operations_shopify_customer_rate_policy_global_valid'),
  ('operations_shopify_product_media_delivery_grants', 'operations_shopify_product_media_grants_account_global_valid'),
  ('operations_shopify_product_media_delivery_grants', 'operations_shopify_product_media_grants_channel_global_valid'),
  ('operations_shopify_product_media_delivery_grants', 'operations_shopify_product_media_grants_product_ref_valid'),
  ('operations_tracking_observations', 'operations_tracking_observations_global_valid'),
  ('operations_warehouses', 'operations_warehouses_global_valid'),
  ('operations_waves', 'operations_waves_global_valid'),
  ('workspace_organizations', 'workspace_organizations_reference_code_valid')
) AS source(table_name, constraint_name);

DO $$
DECLARE
  expected_count integer;
  catalog_count integer;
BEGIN
  SELECT count(*) INTO expected_count
  FROM global_id_compatibility_constraint_manifest;
  IF expected_count <> 149 THEN
    RAISE EXCEPTION 'Expected 149 generated Global ID constraint entries, found %',
      expected_count;
  END IF;

  SELECT count(*) INTO catalog_count
  FROM pg_constraint constraint_row
  WHERE constraint_row.contype = 'c'
    AND position('^g' IN pg_get_constraintdef(constraint_row.oid, true)) > 0
    AND position('[0-9]{7}' IN pg_get_constraintdef(constraint_row.oid, true)) > 0
    AND position('[0-9a-v]{12}' IN pg_get_constraintdef(constraint_row.oid, true)) = 0;
  IF catalog_count <> expected_count THEN
    RAISE EXCEPTION
      'Global ID constraint catalog drift: expected %, found % numeric-only checks',
      expected_count,
      catalog_count;
  END IF;

  IF EXISTS (
    (
      SELECT manifest.table_name, manifest.constraint_name
      FROM global_id_compatibility_constraint_manifest manifest
      EXCEPT
      SELECT constraint_row.conrelid::regclass::text, constraint_row.conname
      FROM pg_constraint constraint_row
      WHERE constraint_row.contype = 'c'
        AND position('^g' IN pg_get_constraintdef(constraint_row.oid, true)) > 0
        AND position('[0-9]{7}' IN pg_get_constraintdef(constraint_row.oid, true)) > 0
        AND position('[0-9a-v]{12}' IN pg_get_constraintdef(constraint_row.oid, true)) = 0
    )
    UNION ALL
    (
      SELECT constraint_row.conrelid::regclass::text, constraint_row.conname
      FROM pg_constraint constraint_row
      WHERE constraint_row.contype = 'c'
        AND position('^g' IN pg_get_constraintdef(constraint_row.oid, true)) > 0
        AND position('[0-9]{7}' IN pg_get_constraintdef(constraint_row.oid, true)) > 0
        AND position('[0-9a-v]{12}' IN pg_get_constraintdef(constraint_row.oid, true)) = 0
      EXCEPT
      SELECT manifest.table_name, manifest.constraint_name
      FROM global_id_compatibility_constraint_manifest manifest
    )
  ) THEN
    RAISE EXCEPTION 'Generated Global ID constraint manifest does not match the catalog';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION expand_global_id_compatibility_constraint_batch(
  first_ordinal integer,
  last_ordinal integer
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  manifest record;
  table_oid oid;
  old_definition text;
  new_definition text;
BEGIN
  IF first_ordinal < 1 OR last_ordinal < first_ordinal OR last_ordinal > 149 THEN
    RAISE EXCEPTION 'Invalid Global ID compatibility expansion range: %-%',
      first_ordinal,
      last_ordinal;
  END IF;

  FOR manifest IN
    SELECT ordinal, table_name, constraint_name
    FROM global_id_compatibility_constraint_manifest
    WHERE ordinal BETWEEN first_ordinal AND last_ordinal
    ORDER BY ordinal
  LOOP
    SELECT constraint_row.conrelid, pg_get_constraintdef(constraint_row.oid, true)
    INTO table_oid, old_definition
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = to_regclass(manifest.table_name)
      AND constraint_row.conname = manifest.constraint_name
      AND constraint_row.contype = 'c';

    IF table_oid IS NULL OR old_definition IS NULL THEN
      RAISE EXCEPTION 'Global ID constraint disappeared: %.%',
        manifest.table_name,
        manifest.constraint_name;
    END IF;
    IF position('[0-9a-v]{12}' IN old_definition) > 0 THEN
      RAISE EXCEPTION 'Global ID constraint was expanded outside its batch: %.%',
        manifest.table_name,
        manifest.constraint_name;
    END IF;
    new_definition := replace(
      old_definition,
      '[0-9]{7}',
      '([0-9]{7}|[0-9a-v]{12})'
    );
    IF new_definition = old_definition
      OR position('[0-9a-v]{12}' IN new_definition) = 0
    THEN
      RAISE EXCEPTION 'Global ID constraint could not be expanded: %.%',
        manifest.table_name,
        manifest.constraint_name;
    END IF;

    EXECUTE format(
      'ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I %s NOT VALID',
      table_oid::regclass,
      manifest.constraint_name,
      manifest.constraint_name,
      new_definition
    );
    EXECUTE format(
      'ALTER TABLE %s VALIDATE CONSTRAINT %I',
      table_oid::regclass,
      manifest.constraint_name
    );
    UPDATE global_id_compatibility_constraint_manifest
    SET expanded_at = now()
    WHERE ordinal = manifest.ordinal;
  END LOOP;
END;
$$;
