#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()

function fail(message) {
  console.error(`predeploy check failed: ${message}`)
  process.exit(1)
}

function ok(message) {
  console.log(`OK: ${message}`)
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'))
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited with code ${result.status ?? 'unknown'}`)
  }
}

console.log('Running ClawPilot predeploy verification...')

if (!existsSync(resolve(root, 'package.json'))) {
  fail('missing root package.json')
}

if (!existsSync(resolve(root, 'app_src/package.json'))) {
  fail('missing app_src/package.json')
}

if (!existsSync(resolve(root, 'app_src/vercel.json'))) {
  fail('missing app_src/vercel.json')
}

if (!existsSync(resolve(root, 'railway.json'))) {
  fail('missing railway.json')
}

const vercel = readJson('app_src/vercel.json')
if (String(vercel.installCommand || '') !== 'npm ci') {
  fail('app_src/vercel.json installCommand must be "npm ci"')
}

if (String(vercel.buildCommand || '') !== 'npm run build:vercel') {
  fail('app_src/vercel.json buildCommand must be "npm run build:vercel"')
}

if (String(vercel.outputDirectory || '') !== '.next') {
  fail('app_src/vercel.json outputDirectory must be ".next"')
}

if (!existsSync(resolve(root, 'app_src/package-lock.json'))) {
  fail('missing app_src/package-lock.json required by Vercel npm ci')
}

const railway = readJson('railway.json')
if (String(railway?.deploy?.healthcheckPath || '') !== '/api/health') {
  fail('railway.json deploy.healthcheckPath must be "/api/health"')
}

if (!String(railway?.deploy?.startCommand || '').includes('npm run start:railway')) {
  fail('railway.json deploy.startCommand must use "npm run start:railway"')
}

if (String(railway?.deploy?.preDeployCommand || '') !== 'bash scripts/predeploy-railway.sh') {
  fail('railway.json deploy.preDeployCommand must use scripts/predeploy-railway.sh')
}

const railwayPredeploy = readFileSync(resolve(root, 'scripts/predeploy-railway.sh'), 'utf8')
for (const requiredCommand of [
  'npm run mail:verify',
  'npm run db:migrate',
  'npm run demo:seed',
  'npm run demo:verify',
]) {
  if (!railwayPredeploy.includes(requiredCommand)) {
    fail(`scripts/predeploy-railway.sh must run "${requiredCommand}"`)
  }
}

const railwayStart = readFileSync(resolve(root, 'scripts/start-railway.sh'), 'utf8')
if (!railwayStart.includes('npm run release:record')) {
  fail('scripts/start-railway.sh must record a release after runtime health validation')
}

const healthGatePosition = railwayStart.indexOf('[[ "$HEALTHY" == "1" ]]')
const toastBackfillPosition = railwayStart.indexOf('npm run toast:activate-payment-date-backfill')
const releaseRecordPosition = railwayStart.indexOf('npm run release:record')
if (
  healthGatePosition < 0
  || toastBackfillPosition < healthGatePosition
  || releaseRecordPosition < toastBackfillPosition
) {
  fail('scripts/start-railway.sh must activate staged Toast backfills after health and before release recording')
}
if (releaseRecordPosition < healthGatePosition) {
  fail('scripts/start-railway.sh must record releases only after runtime health validation')
}

for (const requiredPath of [
  'db/migrations/0002_pipeline_outbox_worker.sql',
  'db/migrations/0009_agent_dispatch_outbox.sql',
  'db/migrations/0003_auth_magic_codes.sql',
  'db/migrations/0004_agent_chatgpt_auth.sql',
  'db/migrations/0005_app_users.sql',
  'db/migrations/0006_agent_user_attribution.sql',
  'db/migrations/0007_multi_tenant_workspaces.sql',
  'db/migrations/0008_workspace_security_hardening.sql',
  'db/migrations/0010_user_invitations.sql',
  'db/migrations/0011_knowledge_releases_checkpoints.sql',
  'db/migrations/0012_invitation_release_hardening.sql',
  'db/migrations/0013_invitation_delivery_coordination.sql',
  'db/migrations/0014_invitation_delivery_pending.sql',
  'db/migrations/0015_short_links.sql',
  'db/migrations/0016_document_vectors_and_ai_radar.sql',
  'db/migrations/0016_z_short_link_destination_preflight.sql',
  'db/migrations/0017_short_link_destination_hardening.sql',
  'db/migrations/0018_user_maton_credentials.sql',
  'db/migrations/0019_managed_pipeline_google_resources.sql',
  'db/migrations/0020_crm_gateway_and_reporting.sql',
  'db/migrations/0021_crm_identity_and_organization_hierarchy.sql',
  'db/migrations/0022_pipeline_sheet_access_links.sql',
  'db/migrations/0023_crm_modules_references_and_integrations.sql',
  'db/migrations/0024_versioned_drive_hierarchy_reconciliation.sql',
  'db/migrations/0025_profile_crm_projection_backfill.sql',
  'db/migrations/0026_legacy_drive_hierarchy_cleanup.sql',
  'db/migrations/0027_verified_legacy_drive_cleanup.sql',
  'db/migrations/0028_eventual_drive_cleanup_reconciliation.sql',
  'db/migrations/0029_verified_drive_trash_reconciliation.sql',
  'db/migrations/0030_random_crm_references_and_organization_email.sql',
  'db/migrations/0031_global_crm_reference_number_registry.sql',
  'db/migrations/0032_reference_allocation_leak_cleanup.sql',
  'db/migrations/0033_crm_board_projection_and_legacy_alias_cleanup.sql',
  'db/migrations/0034_account_membership_crm_board_scope.sql',
  'db/migrations/0035_suitecrm_inbound_sync_status.sql',
  'db/migrations/0036_crm_display_text_and_card_semantics.sql',
  'db/migrations/0037_audit_activity_indexes.sql',
  'db/migrations/0038_dedupe_crm_stage_audit.sql',
  'db/migrations/0039_agent_context_memory.sql',
  'db/migrations/0040_browser_sessions_and_impersonation.sql',
  'db/migrations/0041_dashboard_workspace_preferences.sql',
  'db/migrations/0042_crm_opportunity_contacts.sql',
  'db/migrations/0043_crm_interaction_user_mapping.sql',
  'db/migrations/0044_browser_session_ip_attribution.sql',
  'db/migrations/0045_pipeline_people_products_and_dropdown_catalogs.sql',
  'db/migrations/0046_atomic_pipeline_products_and_sync_retry_state.sql',
  'db/migrations/0047_workspace_organization_branding.sql',
  'db/migrations/0048_canonical_pipeline_negotiation_spelling.sql',
  'db/migrations/0049_residual_pipeline_catalog_repair.sql',
  'db/migrations/0050_historical_pipeline_catalog_restore.sql',
  'db/migrations/0051_preserve_configured_pipeline_dropdowns.sql',
  'db/migrations/0052_restore_canonical_dropdown_layout.sql',
  'db/migrations/0053_seed_empty_pipeline_templates.sql',
  'db/migrations/0054_crm_contact_owner_user_identity.sql',
  'db/migrations/0055_repository_runner_control_plane.sql',
  'db/migrations/0056_crm_employee_identity_and_workbook_dashboard.sql',
  'db/migrations/0057_canonical_suitecrm_usernames.sql',
  'db/migrations/0058_agent_public_research_outbox.sql',
  'db/migrations/0059_toast_restaurant_integrations.sql',
  'db/migrations/0060_multi_workspace_memberships.sql',
  'db/migrations/0061_quickbooks_organization_connector.sql',
  'db/migrations/0062_quickbooks_financial_explorer.sql',
  'db/migrations/0063_quickbooks_financial_reports.sql',
  'db/migrations/0064_quickbooks_write_control.sql',
  'db/migrations/0065_demo_and_quickbooks_crm_reconciliation.sql',
  'db/migrations/0066_demo_workspace_account.sql',
  'db/migrations/0067_toast_pos_orders.sql',
  'db/migrations/0068_quickbooks_write_connection_binding.sql',
  'db/migrations/0069_pos_accounting_profiles_and_catalog_mappings.sql',
  'db/migrations/0070_toast_menu_catalog.sql',
  'db/migrations/0071_quickbooks_accounting_reference_catalogs.sql',
  'db/migrations/0072_toast_sync_rerun_requests.sql',
  'db/migrations/0073_toast_sync_worker_hardening.sql',
  'db/migrations/0074_pos_accounting_issue_notifications.sql',
  'db/migrations/0075_quickbooks_write_binding_compatibility.sql',
  'db/migrations/0076_pos_accounting_notification_consent.sql',
  'db/migrations/0077_zero_sales_accounting_draft_suppression.sql',
  'db/migrations/0078_pos_accounting_date_commands.sql',
  'db/migrations/0079_pos_accounting_posting_outcomes.sql',
  'db/migrations/0080_external_pos_accounting_outcomes.sql',
  'db/migrations/0081_distributed_operations_foundation.sql',
  'db/migrations/0082_operations_activation_and_command_safety.sql',
  'db/migrations/0083_crm_interaction_contacts.sql',
  'db/migrations/0084_operations_command_results.sql',
  'db/migrations/0085_operations_package_workflow.sql',
  'db/migrations/0086_product_packaging_profiles.sql',
  'db/migrations/0087_operations_carrier_credentials.sql',
  'db/migrations/0088_operations_sandbox_rating_and_mock_retirement.sql',
  'db/migrations/0089_operations_rate_delegation_and_carrier_settlement.sql',
  'db/migrations/0090_operations_carrier_accounts_and_gl_coding.sql',
  'db/migrations/0091_operations_printer_configuration.sql',
  'db/migrations/0092_operations_carrier_billing_integrity.sql',
  'db/migrations/0093_operations_carrier_billing_import_and_review.sql',
  'db/migrations/0094_operations_print_delivery.sql',
  'db/migrations/0095_crm_native_activity_projection.sql',
  'db/migrations/0096_crm_contact_identity_aliases.sql',
  'db/migrations/0097_operations_settlement_lifecycle.sql',
  'db/migrations/0098_operations_label_execution.sql',
  'db/migrations/0099_operations_shipment_completion.sql',
  'db/migrations/0100_operations_sandbox_rate_diagnostic_scope.sql',
  'db/migrations/0101_operations_receiving_and_topology.sql',
  'db/migrations/0102_pos_payment_exceptions.sql',
  'db/migrations/0103_pipeline_crm_reference_quarantine.sql',
  'db/migrations/0104_demo_managed_resource_guard.sql',
  'db/migrations/0105_quickbooks_pos_evidence_refresh.sql',
  'db/migrations/0106_toast_location_closeout_hour.sql',
  'db/migrations/0107_operations_warehouse_operating_profile.sql',
  'db/migrations/0108_operations_slotting_and_replenishment.sql',
  'db/migrations/0109_operations_replenishment_execution.sql',
  'db/migrations/0110_operations_carrier_account_sender_name.sql',
  'db/migrations/0111_operations_commerce_integrations.sql',
  'db/migrations/0112_operations_faire_oauth.sql',
  'db/migrations/0113_operations_shopify_order_preview.sql',
  'db/migrations/0114_operations_commerce_normalization.sql',
  'db/migrations/0115_operations_commerce_intake_continuations.sql',
  'db/migrations/0116_operations_carrier_rate_test_labels.sql',
  'db/migrations/0117_operations_print_agent_capabilities.sql',
  'db/migrations/0118_operations_carrier_label_output_artifacts.sql',
  'db/migrations/0119_operations_commerce_product_intake_policy.sql',
  'db/migrations/0120_operations_commerce_catalog_sync.sql',
  'db/migrations/0121_operations_package_contents.sql',
  'db/migrations/0122_operations_commerce_incomplete_header_money.sql',
  'db/migrations/0123_operations_packaging_materials.sql',
  'db/migrations/0124_operations_shopify_inventory.sql',
  'db/migrations/0125_measurement_preferences.sql',
  'db/migrations/0126_packaging_material_unit_neutral_names.sql',
  'db/migrations/0127_workspace_currency_preference.sql',
  'db/migrations/0128_operations_pack_hierarchy.sql',
  'db/migrations/0129_crm_data_transfers.sql',
  'db/migrations/0130_operations_product_channel_states.sql',
  'db/migrations/0131_crm_product_identity_aliases.sql',
  'db/migrations/0132_operations_product_channel_offers.sql',
  'db/migrations/0133_operations_pack_runtime_association.sql',
  'db/migrations/0134_operations_commerce_pack_resolution.sql',
  'db/migrations/0135_operations_hybrid_cartonization_recipes.sql',
  'db/migrations/0136_operations_cartonization_package_rates.sql',
  'db/migrations/0137_operations_cartonization_rate_evidence.sql',
  'db/migrations/0138_operations_cartonization_rate_evidence_integrity.sql',
  'db/migrations/0139_operations_fulfilled_line_price_state.sql',
  'db/migrations/0140_operations_commerce_packaging_source_constraint.sql',
  'db/migrations/0141_operations_recipe_only_pack_associations.sql',
  'db/migrations/0142_operations_cartonization_evidence_scale.sql',
  'db/migrations/0143_operations_cartonization_shipment_rates.sql',
  'db/migrations/0144_operations_cartonization_shipment_rate_constraint_repair.sql',
  'db/migrations/0145_operations_two_pass_pack_rate_runs.sql',
  'db/migrations/0146_operations_pack_rate_pricing_semantics.sql',
  'db/migrations/0147_operations_carrier_billing_mud.sql',
  'db/migrations/0148_operations_commerce_external_effects.sql',
  'db/migrations/0149_operations_shopify_checkout_rating.sql',
  'db/migrations/0150_operations_shopify_carrier_service_mutation_authorization.sql',
  'db/migrations/0151_operations_product_pack_management_hardening.sql',
  'db/migrations/0152_operations_product_channel_taxonomy.sql',
  'db/migrations/0153_crm_product_image_assets.sql',
  'db/migrations/0154_shopify_product_media_delivery_grants.sql',
  'db/migrations/0155_shopify_product_media_authority_and_reconciliation.sql',
  'db/migrations/0156_operations_shopify_carrier_service_active_authorization.sql',
  'db/migrations/0157_operations_shopify_checkout_receipt_reuse.sql',
  'db/migrations/0158_operations_commerce_current_issue_index.sql',
  'db/migrations/0159_operations_shopify_receipt_and_carrier_authority.sql',
  'db/migrations/0160_operations_shopify_product_media_shadow_authority.sql',
  'db/migrations/0161_shopify_product_media_unknown_reconciliation.sql',
  'db/migrations/0162_operations_shopify_checkout_mapping_account_status.sql',
  'db/migrations/0163_shopify_variant_catalog_refresh_recovery.sql',
  'db/migrations/0164_shopify_checkout_offer_parcel_evidence.sql',
  'db/migrations/0165_shopify_store_entity_readiness.sql',
  'db/migrations/0166_shopify_carrier_service_name_alignment.sql',
  'db/migrations/0169_operations_shopify_inventory_refresh_queue.sql',
  'db/migrations/0170_operations_shopify_checkout_plan_rate_policy.sql',
  'db/migrations/0171_shopify_active_account_readiness.sql',
  'db/migrations/0172_operations_commerce_inventory_attempt_lease_renewal.sql',
  'db/migrations/0173_operations_shopify_shipping_service_codes.sql',
  'db/migrations/0174_operations_shopify_checkout_provider_attempts.sql',
  'db/migrations/0175_operations_shopify_checkout_rate_warm_policy.sql',
  'db/migrations/0176_operations_canonical_fulfillment_planning.sql',
  'db/migrations/0177_operations_fulfillment_executions.sql',
  'db/migrations/0178_operations_shopify_customer_rate_policies.sql',
  'db/migrations/0179_operations_active_multi_package_execution.sql',
  'db/migrations/0180_operations_production_fulfillment_rerates.sql',
  'db/migrations/0181_operations_shopify_shadow_policy_lifetime.sql',
  'db/migrations/0188_operations_shopify_shadow_test_subsidy.sql',
  'db/migrations/0189_operations_shopify_checkout_quote_match_families.sql',
  'db/migrations/0190_operations_shopify_inventory_webhook_refresh.sql',
  'db/migrations/0191_operations_commerce_pack_evidence_fingerprint.sql',
  'db/migrations/0192_operations_shadow_fulfillment_destination_fingerprint.sql',
  'db/migrations/0193_operations_shadow_rate_choice_package_identity.sql',
  'db/migrations/0194_operations_fulfillment_execution_union_repair.sql',
  'db/migrations/0195_operations_fulfillment_rate_parcel_evidence.sql',
  'db/migrations/0197_operations_shopify_catalog_webhook_refresh.sql',
  'app_src/app/api/crm/products/[productId]/images/route.ts',
  'app_src/app/api/crm/products/[productId]/images/[assetId]/route.ts',
  'app_src/app/api/crm/products/[productId]/shopify-product-image/route.ts',
  'app_src/app/api/integrations/commerce/shopify/product-media/[token]/route.ts',
  'app_src/app/api/operations/product-pack-profiles/route.ts',
  'app_src/components/crm/ProductImagePanel.tsx',
  'app_src/components/crm/ProductPackProfilePanel.tsx',
  'app_src/lib/crm/productImageAssets.ts',
  'app_src/lib/integrations/shopifyProductMediaProjection.ts',
  'app_src/lib/integrations/shopifyProductMediaProjectionTypes.ts',
  'app_src/lib/integrations/shopifyProductMediaTokens.ts',
  'app_src/lib/integrations/shopifyProductWriteback.ts',
  'app_src/lib/operations/productPackManagement.ts',
  'app_src/lib/persistence/crmProductImageAssets.ts',
  'app_src/lib/persistence/productPackManagement.ts',
  'app_src/lib/persistence/shopifyProductMediaProjection.ts',
  'app_src/tests/crm/product-image-assets.test.ts',
  'app_src/tests/crm/product-image-panel.test.mts',
  'app_src/tests/integrations/shopify-product-media-token.test.ts',
  'app_src/tests/operations/product-pack-management.test.mts',
  'scripts/test-crm-product-image-assets.mjs',
  'scripts/test-product-pack-management.mjs',
  'scripts/test-shopify-product-image-publish.mjs',
  'scripts/test-shopify-product-writeback.mjs',
  'scripts/test-shopify-store-entity-readiness.mjs',
  'scripts/test-shopify-store-entity-readiness-postgres.mjs',
  'scripts/test-shopify-customer-rate-policies.mjs',
  'scripts/test-shopify-customer-rate-policy-ui.mjs',
  'scripts/test-shopify-customer-rate-policies-postgres.mjs',
  'app_src/lib/integrations/commercePackRuntime.ts',
  'app_src/lib/operations/hybridCartonization.ts',
  'app_src/tests/operations/hybrid-cartonization.test.mts',
  'app_src/lib/persistence/hybridCartonization.ts',
  'app_src/lib/persistence/cartonizationRateEvidence.ts',
  'app_src/lib/operations/canonicalFulfillmentPlanning.ts',
  'app_src/lib/operations/activeFulfillmentExecution.ts',
  'app_src/lib/operations/activeCarrierDispatchSnapshot.ts',
  'app_src/lib/operations/productionFulfillmentRerates.ts',
  'app_src/lib/integrations/carrierWholeShipmentRateFoundation.ts',
  'app_src/tests/operations/canonical-fulfillment-planning.test.mts',
  'app_src/tests/operations/active-carrier-dispatch-snapshot.test.mts',
  'app_src/lib/operations/regressionReplay.ts',
  'app_src/lib/persistence/operationsRegressionArtifacts.ts',
  'app_src/lib/persistence/operationsRegressionReplay.ts',
  'app_src/lib/operations/glCoding.ts',
  'app_src/lib/persistence/glCoding.ts',
  'app_src/app/api/operations/regression-replays/route.ts',
  'app_src/tests/integrations/commerce-pack-runtime.test.ts',
  'scripts/test-measurement-preferences.mjs',
  'scripts/test-cartonization-preview.mjs',
  'scripts/test-cartonization-rate-evidence.mjs',
  'scripts/test-canonical-fulfillment-planning-postgres.mjs',
  'scripts/test-operation-active-multi-package-execution-contracts.mjs',
  'scripts/test-operation-production-fulfillment-rerate-contracts.mjs',
  'scripts/test-operation-production-fulfillment-rerates-postgres.mjs',
  'scripts/test-carrier-whole-shipment-rate-foundation.mjs',
  'scripts/fixtures/carrier-rates/ups-whole-shipment-recorded.json',
  'scripts/fixtures/carrier-rates/fedex-whole-shipment-recorded.json',
  'scripts/test-hybrid-cartonization-persistence.mjs',
  'scripts/test-operations-regression-artifacts.mjs',
  'scripts/test-operations-regression-replay.mjs',
  'scripts/test-operations-regression-replay-postgres.mjs',
  'app_src/lib/operations/casePackPlanning.ts',
  'app_src/tests/operations/case-pack-planning.test.mts',
  'scripts/test-carrier-rate-test-labels.mjs',
  'scripts/test-establish-ag-alchemy-carrier-sandbox.mjs',
  'scripts/test-prove-ag-alchemy-carrier-sandbox-rating.mjs',
  'scripts/test-commerce-order-reconciliation.mjs',
  'scripts/test-operations-packaging-materials.mjs',
  'scripts/stage-ag-alchemy-pack-hierarchy.mjs',
  'scripts/test-fulfillment-optimizer-service.mjs',
  'scripts/establish-ag-alchemy-carrier-sandbox.mjs',
  'scripts/prove-ag-alchemy-carrier-sandbox-rating.mjs',
  'scripts/test-commerce-integrations.mjs',
  'scripts/test-commerce-normalization-schema.mjs',
  'scripts/test-commerce-normalizers.mjs',
  'scripts/test-commerce-intake.mjs',
  'scripts/test-product-channel-states.mjs',
  'scripts/test-product-identity-reconciliation.mjs',
  'scripts/test-commerce-inventory.mjs',
  'scripts/test-shopify-inventory-refresh-worker.mjs',
  'scripts/test-shopify-inventory-refresh-postgres.mjs',
  'scripts/test-shopify-catalog-webhook-refresh.mjs',
  'scripts/test-shopify-checkout-plan-rate-policy-postgres.mjs',
  'scripts/reconcile-ag-alchemy-commerce-product-names.mjs',
  'app_src/app/api/integrations/commerce/route.ts',
  'app_src/app/api/integrations/commerce/intake/route.ts',
  'app_src/app/api/integrations/commerce/intake/cartonization-preview/route.ts',
  'app_src/app/api/integrations/commerce/inventory/route.ts',
  'app_src/app/api/integrations/commerce/inventory/process/route.ts',
  'app_src/app/api/integrations/commerce/orders/process/route.ts',
  'app_src/app/api/integrations/commerce/faire/oauth/callback/route.ts',
  'app_src/app/api/integrations/commerce/shopify/order-preview/route.ts',
  'app_src/app/api/integrations/commerce/shopify/webhooks/[accountGlobalId]/route.ts',
  'app_src/components/settings/CommerceIntegrationPanel.tsx',
  'app_src/components/settings/CommerceIntakeWorkflow.tsx',
  'app_src/lib/integrations/commerceCanonicalProductIdentity.ts',
  'app_src/lib/integrations/commerceProductLifecycle.ts',
  'app_src/lib/persistence/productChannelStates.ts',
  'app_src/lib/persistence/productIdentity.ts',
  'app_src/app/api/crm/product-identities/route.ts',
  'app_src/components/crm/ProductIdentityDialog.tsx',
  'app_src/tests/integrations/commerce-canonical-product-identity.test.ts',
  'app_src/tests/integrations/commerce-product-lifecycle.test.ts',
  'app_src/components/settings/MeasurementPreferencesPanel.tsx',
  'app_src/components/operations/CommerceImportsPanel.tsx',
  'app_src/components/operations/PackagingMaterialsPanel.tsx',
  'app_src/components/operations/ShopifyInventoryPanel.tsx',
  'app_src/components/measurements/MeasurementSystemProvider.tsx',
  'app_src/app/api/operations/packaging-materials/route.ts',
  'app_src/app/api/settings/measurement-preferences/route.ts',
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  'app_src/lib/integrations/commerceCapabilities.ts',
  'app_src/lib/integrations/commerceCredentialCrypto.ts',
  'app_src/lib/integrations/commerceIntake.ts',
  'app_src/lib/integrations/commerceIntakeCsv.ts',
  'app_src/lib/integrations/commerceIntegrations.ts',
  'app_src/lib/integrations/commerceInventory.ts',
  'app_src/lib/shopifyInventoryRefreshWorker.ts',
  'app_src/lib/integrations/commerceProductNaming.ts',
  'app_src/lib/integrations/faireCommerceClient.ts',
  'app_src/lib/integrations/faireCommerceNormalizer.ts',
  'app_src/lib/integrations/shopifyCommerceClient.ts',
  'app_src/lib/integrations/shopifyCommerceNormalizer.ts',
  'app_src/lib/integrations/shopifyInventory.ts',
  'app_src/lib/integrations/shopifyOrderPreview.ts',
  'app_src/lib/operations/commerceNormalization.ts',
  'app_src/lib/operations/cartonizationPreview.ts',
  'app_src/lib/operations/shopifyInventoryProjection.ts',
  'app_src/lib/operations/fulfillmentOptimizerContract.ts',
  'app_src/lib/operations/orToolsFulfillmentOptimizer.ts',
  'app_src/lib/operations/packagingMaterials.ts',
  'app_src/lib/measurements.ts',
  'app_src/lib/currency.ts',
  'app_src/lib/persistence/commerceIntake.ts',
  'app_src/lib/persistence/commerceOrderReconciliation.ts',
  'app_src/lib/persistence/commerceIntegrations.ts',
  'app_src/lib/persistence/commerceInventory.ts',
  'app_src/lib/persistence/shopifyInventoryRefresh.ts',
  'app_src/lib/persistence/commerceOrderPreviews.ts',
  'app_src/lib/persistence/cartonizationPreview.ts',
  'app_src/lib/persistence/packagingMaterials.ts',
  'app_src/lib/persistence/measurementPreferences.ts',
  'app_src/lib/crm/dataTransferCsv.ts',
  'app_src/lib/persistence/crmDataTransfers.ts',
  'app_src/app/api/crm/data-transfer/route.ts',
  'app_src/components/crm/CrmDataTransferDialog.tsx',
  'app_src/tests/crm/data-transfer-csv.test.ts',
  'app_src/tests/measurements/measurements.test.ts',
  'app_src/tests/integrations/commerce-product-naming.test.ts',
  'services/fulfillment-optimizer/Dockerfile',
  'services/fulfillment-optimizer/railway.json',
  'services/fulfillment-optimizer/requirements.txt',
  'services/fulfillment-optimizer/optimizer_service/main.py',
  'services/fulfillment-optimizer/optimizer_service/models.py',
  'services/fulfillment-optimizer/optimizer_service/solver.py',
  '.github/workflows/clawpilot-repository-runner.yml',
  '.github/workflows/deployed-runtime-monitor.yml',
  'scripts/start-railway.sh',
  'scripts/activate-toast-payment-date-backfill.mjs',
  'scripts/test-suitecrm-interaction-ingestion.mjs',
  'scripts/test-suitecrm-call-ingestion.mjs',
  'scripts/test-crm-contact-identity.mjs',
  'scripts/test-crm-data-transfer.mjs',
  'scripts/merge-crm-contacts.mjs',
  'scripts/pipeline-outbox-poller.mjs',
  'scripts/verify-tenancy-provisioning.mjs',
  'scripts/validate-runtime-config.mjs',
  'scripts/smoke-deployed-runtime.mjs',
  'scripts/monitor-deployed-runtime.mjs',
  'scripts/test-deployed-runtime-monitor.mjs',
  'scripts/record-release.mjs',
  'scripts/verify-repository-hygiene.mjs',
  'scripts/vercel-build.mjs',
  'scripts/verify-mail-sender.mjs',
  'scripts/test-operation-printing.mjs',
  'scripts/test-operation-print-agent-runtime.mjs',
  'scripts/calibrate-zebra-printer.mjs',
  'scripts/test-zebra-printer-calibration.mjs',
  'scripts/test-operation-shipment-completion.mjs',
  'scripts/test-operations-print-delivery.mjs',
  'scripts/test-carrier-billing-import.mjs',
  'scripts/test-carrier-billing-persistence.mjs',
  'scripts/test-carrier-billing-integrity.mjs',
  'docs/index.md',
  'docs/modules/toast-and-accounting.md',
  'docs/modules/wms-development-simulation.md',
  'docs/operations/printing-carrier-billing-and-gl-coding.md',
  'docs/operations/local-print-agent.md',
  'docs/releases/catalog.json',
  'app_src/proxy.ts',
  'app_src/app/api/auth/magic/request/route.ts',
  'app_src/app/api/auth/magic/verify/route.ts',
  'app_src/app/api/auth/session/route.ts',
  'app_src/app/api/operations/printers/route.ts',
  'app_src/components/operations/PrinterConfigurationPanel.tsx',
  'app_src/lib/operations/printing.ts',
  'app_src/lib/persistence/operationPrinting.ts',
  'app_src/app/api/auth/session/activity/route.ts',
  'app_src/app/api/auth/sessions/route.ts',
  'app_src/app/api/auth/impersonation/route.ts',
  'app_src/app/api/agents/auth/route.ts',
  'app_src/app/api/agents/auth/poll/route.ts',
  'app_src/app/api/agents/dispatch/process/route.ts',
  'app_src/app/api/agents/research/process/route.ts',
  'app_src/app/api/agents/repository-runs/route.ts',
  'app_src/app/api/agents/repository-runs/process/route.ts',
  'app_src/app/api/agents/repository-runs/report/route.ts',
  'app_src/app/api/ai-radar/process/route.ts',
  'app_src/app/api/docs/embeddings/process/route.ts',
  'app_src/app/api/shortlinks/route.ts',
  'app_src/app/api/crm/actions/route.ts',
  'app_src/app/api/crm/integrations/process/route.ts',
  'app_src/app/api/integrations/maton/route.ts',
  'app_src/app/api/integrations/google-workspace/route.ts',
  'app_src/app/api/integrations/toast/route.ts',
  'app_src/app/api/integrations/toast/process/route.ts',
  'app_src/app/api/integrations/quickbooks/route.ts',
  'app_src/app/api/integrations/quickbooks/process/route.ts',
  'app_src/app/s/[slug]/route.ts',
  'app_src/lib/agentDispatchWorker.ts',
  'app_src/lib/agentResearchWorker.ts',
  'app_src/lib/persistence/agentResearch.ts',
  'app_src/lib/integrations/toastClient.ts',
  'app_src/lib/integrations/toastCredentialCrypto.ts',
  'app_src/lib/integrations/toastIntegrations.ts',
  'app_src/lib/persistence/toastIntegrations.ts',
  'app_src/lib/toastSyncWorker.ts',
  'app_src/lib/integrations/quickBooksCatalog.mjs',
  'app_src/lib/integrations/quickBooksClient.ts',
  'app_src/lib/integrations/quickBooksIntegrations.ts',
  'app_src/lib/persistence/quickBooksIntegrations.ts',
  'app_src/lib/quickBooksSyncWorker.ts',
  'app_src/lib/agents/repositoryRunnerConfig.ts',
  'app_src/lib/githubApp.ts',
  'app_src/lib/persistence/repositoryRuns.ts',
  'app_src/lib/repositoryRunWorker.ts',
  'scripts/test-repository-runner.mjs',
  'app_src/lib/authSessions.ts',
  'app_src/lib/authAttribution.ts',
  'app_src/lib/requestIpAddress.ts',
  'app_src/lib/workerAuth.ts',
  'app_src/lib/aiRadar.ts',
  'app_src/lib/documentEmbeddings.ts',
  'app_src/lib/shortlinks.ts',
  'app_src/lib/crm/integrationActions.ts',
  'app_src/lib/crm/emailIngestion.ts',
  'app_src/lib/integrations/matonCredentials.ts',
  'app_src/lib/integrations/googleWorkspace.ts',
  'app_src/lib/integrations/googleWorkspaceClient.ts',
  'app_src/lib/integrations/googleWorkspaceCrypto.ts',
  'app_src/lib/persistence/googleWorkspace.ts',
  'app_src/lib/persistence/matonCredentials.ts',
  'app_src/components/settings/GoogleWorkspaceIntegrationPanel.tsx',
  'app_src/components/settings/IntegrationSettingsPanel.tsx',
  'app_src/components/settings/ToastIntegrationPanel.tsx',
  'app_src/components/settings/QuickBooksIntegrationPanel.tsx',
  'app_src/app/api/users/route.ts',
  'app_src/app/api/invitations/accept/route.ts',
  'app_src/app/api/docs/route.ts',
  'app_src/app/api/versions/route.ts',
  'app_src/app/api/pipeline/sync/outbox/process/route.ts',
]) {
  if (!existsSync(resolve(root, requiredPath))) {
    fail(`missing deployment runtime file: ${requiredPath}`)
  }
}

run('npm', ['run', 'build'])

if (!existsSync(resolve(root, 'app_src/.next/BUILD_ID'))) {
  fail('missing build artifact: app_src/.next/BUILD_ID')
}

ok('predeploy verification passed')
