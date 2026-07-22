import { NextResponse } from 'next/server'
import fs from 'fs'
import { getAgentRuntime } from '@/lib/agents/provider'
import { getRepositoryRunnerConfiguration } from '@/lib/agents/repositoryRunnerConfig'
import { getStorageDriver, isHostedRuntime } from '@/lib/persistence/config'
import { query as queryAgentCredentials } from '@/lib/persistence/agentCredentials'
import { query } from '@/lib/persistence/postgres'
import { readPipelineOutboxWorkerHeartbeatFromPostgres } from '@/lib/persistence/pipeline'
import { readAgentDispatchWorkerHeartbeatFromPostgres } from '@/lib/persistence/agentDispatch'
import { readAgentResearchWorkerHeartbeatFromPostgres } from '@/lib/persistence/agentResearch'
import { readToastWorkerHeartbeatFromPostgres } from '@/lib/persistence/toastIntegrations'
import { readQuickBooksWorkerHeartbeatFromPostgres } from '@/lib/persistence/quickBooksIntegrations'
import { effectiveDocumentEmbeddingConfiguration } from '@/lib/documentEmbeddings'
import { validateShortLinkConfiguration } from '@/lib/shortlinks'
import { readSuiteCrmWorkerHeartbeat } from '@/lib/persistence/crm'
import { suiteCrmBaseUrl } from '@/lib/crm/suiteCrmClient'

const DEV_LOG_PATH = '/tmp/clawd-app-dev.log'
const FALLBACK_LOG_PATH = '/tmp/clawd-app.log'
const ERROR_PATTERNS = [/⨯/, /Error:/, /error TS/, /TypeError/, /ReferenceError/, /SyntaxError/, /Unhandled/, /ENOENT/, /500/]
const WINDOW_MS = 5 * 60 * 1000 // last 5 minutes
const MAX_BYTES_TO_SCAN = 256 * 1024

function resolveLogPath(): { path: string; expectedDevLogPresent: boolean; usedFallback: boolean } {
  const expectedDevLogPresent = fs.existsSync(DEV_LOG_PATH)
  if (expectedDevLogPresent) {
    return { path: DEV_LOG_PATH, expectedDevLogPresent, usedFallback: false }
  }

  if (fs.existsSync(FALLBACK_LOG_PATH)) {
    return { path: FALLBACK_LOG_PATH, expectedDevLogPresent, usedFallback: true }
  }

  return { path: DEV_LOG_PATH, expectedDevLogPresent, usedFallback: false }
}

function readLogTailUtf8(path: string, bytes: number): string {
  const stat = fs.statSync(path)
  const size = stat.size
  if (size <= 0) return ''

  const chunkSize = Math.min(size, bytes)
  const start = Math.max(0, size - chunkSize)
  const fd = fs.openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(chunkSize)
    fs.readSync(fd, buffer, 0, chunkSize, start)
    return buffer.toString('utf-8')
  } finally {
    fs.closeSync(fd)
  }
}

export async function GET() {
  const checkedAt = Date.now()
  const railwayRuntime = Boolean(
    process.env.RAILWAY_ENVIRONMENT_NAME
    || process.env.RAILWAY_ENVIRONMENT_ID
    || process.env.RAILWAY_PROJECT_ID
    || process.env.RAILWAY_ENVIRONMENT,
  )
  const cloudProvider = railwayRuntime ? 'railway' : process.env.VERCEL ? 'vercel' : null

  if (isHostedRuntime()) {
    const errors: string[] = []
    const warnings: string[] = []
    const storage = getStorageDriver()
    let database: Record<string, unknown> = { status: 'not-configured' }
    let credentialStore: Record<string, unknown> = { status: 'not-configured' }
    let worker: Record<string, unknown> = { status: 'not-owned' }
    let agentWorker: Record<string, unknown> = { status: 'not-owned' }
    let agentResearchWorker: Record<string, unknown> = { status: 'not-owned' }
    let toastWorker: Record<string, unknown> = { status: 'not-owned' }
    let quickBooksWorker: Record<string, unknown> = { status: 'not-owned' }
    let integrationQueues: Record<string, unknown> = { status: 'not-configured' }
    let crm: Record<string, unknown> = { status: 'disabled' }
    let knowledgeWorkers: Array<Record<string, unknown>> = []
    const repositoryRunner = getRepositoryRunnerConfiguration()

    if (cloudProvider === 'railway' && storage !== 'postgres') {
      errors.push('Railway runtime requires Postgres storage.')
    }
    if (process.env.APP_AUTH_REQUIRED !== '1') {
      errors.push('Hosted runtime authentication is not enabled.')
    }
    if (String(process.env.APP_LOGIN_PASSWORD || '').length < 16) {
      errors.push('Hosted runtime login password is missing or too short.')
    }
    if (!String(process.env.APP_LOGIN_EMAIL || '').includes('@')) {
      errors.push('Hosted runtime operator email is not configured.')
    }
    if (String(process.env.APP_SESSION_SECRET || process.env.NEXTAUTH_SECRET || '').length < 32) {
      errors.push('Hosted runtime session secret is missing or too short.')
    }
    if (String(process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY || '').length < 32) {
      errors.push('Hosted runtime agent credential encryption key is missing or too short.')
    }
    if (String(process.env.AGENT_CREDENTIAL_DATABASE_URL || '').length < 16) {
      errors.push('Hosted runtime agent credential database is not configured.')
    } else {
      try {
        await queryAgentCredentials('SELECT operator_id FROM agent_chatgpt_credentials LIMIT 1')
        credentialStore = { status: 'reachable', shared: true }
      } catch (error) {
        credentialStore = { status: 'unreachable', shared: true }
        console.error('[health] Agent credential store health check failed', error)
        errors.push('Agent credential store is unreachable.')
      }
    }
    if (String(process.env.MATON_API_KEY || '').length < 16) {
      errors.push('Hosted runtime Maton credential is missing or too short.')
    }
    if (String(process.env.MATON_GMAIL_CONNECTION_ID || '').length < 8) {
      errors.push('Hosted runtime Maton Gmail connection is not configured.')
    }
    if (repositoryRunner.enabled && !repositoryRunner.ready) {
      errors.push(repositoryRunner.reason)
    }
    if (!String(process.env.CLAWPILOT_MAIL_FROM || '').includes('@')) {
      errors.push('Hosted runtime ClawPilot mail sender is not configured.')
    }
    try {
      const publicUrl = new URL(String(process.env.CLAWPILOT_PUBLIC_URL || ''))
      if (publicUrl.protocol !== 'https:') errors.push('Hosted runtime public URL must use HTTPS.')
    } catch {
      errors.push('Hosted runtime public URL is not configured.')
    }
    if (String(process.env.PIPELINE_SHEET_ID || '').length < 20) {
      errors.push('Hosted runtime pipeline Sheet is not configured.')
    }
    if (cloudProvider === 'railway' && String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '').length < 32) {
      errors.push('Pipeline outbox worker credential is missing or too short.')
    }
    if (cloudProvider === 'railway' && process.env.CLAWPILOT_DB_FALLBACK_TO_FILE !== 'false') {
      errors.push('Railway database fallback must be disabled.')
    }
    const crmEnabled = process.env.CRM_ENABLED === '1'
    if (crmEnabled) {
      try {
        suiteCrmBaseUrl()
        if (String(process.env.SUITECRM_CLIENT_ID || '').length < 16) throw new Error('SuiteCRM client ID is missing or too short.')
        if (String(process.env.SUITECRM_CLIENT_SECRET || '').length < 32) throw new Error('SuiteCRM client secret is missing or too short.')
        crm = { status: 'configured' }
      } catch (error) {
        crm = { status: 'misconfigured' }
        errors.push(error instanceof Error ? error.message : 'SuiteCRM configuration is invalid.')
      }
    }
    try {
      validateShortLinkConfiguration({ requireServiceClient: true, requirePublicOrigin: true })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Short-link configuration is invalid.')
    }
    let embeddingProvider: 'local' | 'openai' = 'local'
    try {
      embeddingProvider = (await effectiveDocumentEmbeddingConfiguration()).provider
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Document embedding configuration is invalid.')
    }

    if (storage === 'postgres') {
      try {
        const result = await query<{
          now: string
          worker_migration_applied: boolean
          auth_migration_applied: boolean
          agent_auth_migration_applied: boolean
          users_migration_applied: boolean
          attribution_migration_applied: boolean
          workspaces_migration_applied: boolean
          workspace_security_migration_applied: boolean
          agent_dispatch_migration_applied: boolean
          invitation_migration_applied: boolean
          knowledge_migration_applied: boolean
          hardening_migration_applied: boolean
          invitation_delivery_migration_applied: boolean
          invitation_pending_migration_applied: boolean
          shortlinks_migration_applied: boolean
          vector_knowledge_migration_applied: boolean
          shortlink_preflight_migration_applied: boolean
          shortlink_hardening_migration_applied: boolean
          maton_credentials_migration_applied: boolean
          managed_pipeline_resources_migration_applied: boolean
          crm_gateway_migration_applied: boolean
          crm_identity_hierarchy_migration_applied: boolean
          pipeline_sheet_links_migration_applied: boolean
          crm_integrations_migration_applied: boolean
          crm_board_projection_migration_applied: boolean
          account_membership_migration_applied: boolean
          suitecrm_inbound_sync_migration_applied: boolean
          crm_display_text_migration_applied: boolean
          browser_sessions_migration_applied: boolean
          workspace_preferences_migration_applied: boolean
          pipeline_catalog_migration_applied: boolean
          atomic_product_catalog_migration_applied: boolean
          organization_branding_migration_applied: boolean
          pipeline_spelling_migration_applied: boolean
          residual_pipeline_catalog_migration_applied: boolean
          historical_pipeline_catalog_migration_applied: boolean
          configured_pipeline_dropdowns_migration_applied: boolean
          canonical_dropdown_layout_migration_applied: boolean
          empty_pipeline_templates_migration_applied: boolean
          crm_contact_owner_identity_migration_applied: boolean
          repository_runner_migration_applied: boolean
          crm_employee_identity_migration_applied: boolean
          canonical_suitecrm_usernames_migration_applied: boolean
          agent_research_migration_applied: boolean
          toast_integrations_migration_applied: boolean
          multi_workspace_memberships_migration_applied: boolean
          quickbooks_connector_migration_applied: boolean
          quickbooks_explorer_migration_applied: boolean
          quickbooks_reports_migration_applied: boolean
          quickbooks_write_control_migration_applied: boolean
          demo_quickbooks_crm_migration_applied: boolean
          demo_workspace_account_migration_applied: boolean
          toast_pos_orders_migration_applied: boolean
          quickbooks_write_connection_binding_migration_applied: boolean
          pos_accounting_profiles_migration_applied: boolean
          toast_menu_catalog_migration_applied: boolean
          quickbooks_reference_catalogs_migration_applied: boolean
          toast_sync_rerun_migration_applied: boolean
          toast_sync_worker_hardening_migration_applied: boolean
          pos_accounting_notifications_migration_applied: boolean
          quickbooks_write_binding_compatibility_migration_applied: boolean
          pos_accounting_notification_consent_migration_applied: boolean
          pos_accounting_date_commands_migration_applied: boolean
          pos_accounting_posting_outcomes_migration_applied: boolean
          external_pos_accounting_outcomes_migration_applied: boolean
          distributed_operations_migration_applied: boolean
          migration_checksums_present: boolean
        }>(
          `
            SELECT
              now()::text AS now,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0002_pipeline_outbox_worker.sql'
              ) AS worker_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0003_auth_magic_codes.sql'
              ) AS auth_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0004_agent_chatgpt_auth.sql'
              ) AS agent_auth_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0005_app_users.sql'
              ) AS users_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0006_agent_user_attribution.sql'
              ) AS attribution_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0007_multi_tenant_workspaces.sql'
              ) AS workspaces_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0008_workspace_security_hardening.sql'
              ) AS workspace_security_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0009_agent_dispatch_outbox.sql'
              ) AS agent_dispatch_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0010_user_invitations.sql'
              ) AS invitation_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0011_knowledge_releases_checkpoints.sql'
              ) AS knowledge_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0012_invitation_release_hardening.sql'
              ) AS hardening_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0013_invitation_delivery_coordination.sql'
              ) AS invitation_delivery_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0014_invitation_delivery_pending.sql'
              ) AS invitation_pending_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0015_short_links.sql'
              ) AS shortlinks_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0016_document_vectors_and_ai_radar.sql'
              ) AS vector_knowledge_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0016_z_short_link_destination_preflight.sql'
              ) AS shortlink_preflight_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0017_short_link_destination_hardening.sql'
              ) AS shortlink_hardening_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0018_user_maton_credentials.sql'
              ) AS maton_credentials_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0019_managed_pipeline_google_resources.sql'
              ) AS managed_pipeline_resources_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0020_crm_gateway_and_reporting.sql'
              ) AS crm_gateway_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0021_crm_identity_and_organization_hierarchy.sql'
              ) AS crm_identity_hierarchy_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0022_pipeline_sheet_access_links.sql'
              ) AS pipeline_sheet_links_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0023_crm_modules_references_and_integrations.sql'
              ) AS crm_integrations_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0033_crm_board_projection_and_legacy_alias_cleanup.sql'
              ) AS crm_board_projection_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0034_account_membership_crm_board_scope.sql'
              ) AS account_membership_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0035_suitecrm_inbound_sync_status.sql'
              ) AS suitecrm_inbound_sync_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0036_crm_display_text_and_card_semantics.sql'
              ) AS crm_display_text_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0040_browser_sessions_and_impersonation.sql'
              ) AS browser_sessions_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0041_dashboard_workspace_preferences.sql'
              ) AS workspace_preferences_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0045_pipeline_people_products_and_dropdown_catalogs.sql'
              ) AS pipeline_catalog_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0046_atomic_pipeline_products_and_sync_retry_state.sql'
              ) AS atomic_product_catalog_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0047_workspace_organization_branding.sql'
              ) AS organization_branding_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0048_canonical_pipeline_negotiation_spelling.sql'
              ) AS pipeline_spelling_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0049_residual_pipeline_catalog_repair.sql'
              ) AS residual_pipeline_catalog_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0050_historical_pipeline_catalog_restore.sql'
              ) AS historical_pipeline_catalog_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0051_preserve_configured_pipeline_dropdowns.sql'
              ) AS configured_pipeline_dropdowns_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0052_restore_canonical_dropdown_layout.sql'
              ) AS canonical_dropdown_layout_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0053_seed_empty_pipeline_templates.sql'
              ) AS empty_pipeline_templates_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0054_crm_contact_owner_user_identity.sql'
              ) AS crm_contact_owner_identity_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0055_repository_runner_control_plane.sql'
              ) AS repository_runner_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0056_crm_employee_identity_and_workbook_dashboard.sql'
              ) AS crm_employee_identity_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0057_canonical_suitecrm_usernames.sql'
              ) AS canonical_suitecrm_usernames_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0058_agent_public_research_outbox.sql'
              ) AS agent_research_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0059_toast_restaurant_integrations.sql'
              ) AS toast_integrations_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0060_multi_workspace_memberships.sql'
              ) AS multi_workspace_memberships_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0061_quickbooks_organization_connector.sql'
              ) AS quickbooks_connector_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0062_quickbooks_financial_explorer.sql'
              ) AS quickbooks_explorer_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0063_quickbooks_financial_reports.sql'
              ) AS quickbooks_reports_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0064_quickbooks_write_control.sql'
              ) AS quickbooks_write_control_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0065_demo_and_quickbooks_crm_reconciliation.sql'
              ) AS demo_quickbooks_crm_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0066_demo_workspace_account.sql'
              ) AS demo_workspace_account_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0067_toast_pos_orders.sql'
              ) AS toast_pos_orders_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0068_quickbooks_write_connection_binding.sql'
              ) AS quickbooks_write_connection_binding_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0069_pos_accounting_profiles_and_catalog_mappings.sql'
              ) AS pos_accounting_profiles_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0070_toast_menu_catalog.sql'
              ) AS toast_menu_catalog_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0071_quickbooks_accounting_reference_catalogs.sql'
              ) AS quickbooks_reference_catalogs_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0072_toast_sync_rerun_requests.sql'
              ) AS toast_sync_rerun_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0073_toast_sync_worker_hardening.sql'
              ) AS toast_sync_worker_hardening_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0074_pos_accounting_issue_notifications.sql'
              ) AS pos_accounting_notifications_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0075_quickbooks_write_binding_compatibility.sql'
              ) AS quickbooks_write_binding_compatibility_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0076_pos_accounting_notification_consent.sql'
              ) AS pos_accounting_notification_consent_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0078_pos_accounting_date_commands.sql'
              ) AS pos_accounting_date_commands_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0079_pos_accounting_posting_outcomes.sql'
              ) AS pos_accounting_posting_outcomes_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0080_external_pos_accounting_outcomes.sql'
              ) AS external_pos_accounting_outcomes_migration_applied,
              EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE filename = '0081_distributed_operations_foundation.sql'
              ) AS distributed_operations_migration_applied,
              NOT EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE checksum IS NULL OR checksum !~ '^[0-9a-f]{64}$'
              ) AS migration_checksums_present
          `,
        )
        const row = result.rows[0]
        database = {
          status: 'reachable',
          checkedAt: row?.now || new Date(checkedAt).toISOString(),
          migrationsCurrent: Boolean(
            row?.worker_migration_applied
            && row?.auth_migration_applied
            && row?.agent_auth_migration_applied
            && row?.users_migration_applied
            && row?.attribution_migration_applied
            && row?.workspaces_migration_applied
            && row?.workspace_security_migration_applied
            && row?.agent_dispatch_migration_applied
            && row?.invitation_migration_applied
            && row?.knowledge_migration_applied
            && row?.hardening_migration_applied
            && row?.invitation_delivery_migration_applied
            && row?.invitation_pending_migration_applied
            && row?.shortlinks_migration_applied
            && row?.vector_knowledge_migration_applied
            && row?.shortlink_preflight_migration_applied
            && row?.shortlink_hardening_migration_applied
            && row?.maton_credentials_migration_applied
            && row?.managed_pipeline_resources_migration_applied
            && row?.crm_gateway_migration_applied
            && row?.crm_identity_hierarchy_migration_applied
            && row?.pipeline_sheet_links_migration_applied
            && row?.crm_integrations_migration_applied
            && row?.crm_board_projection_migration_applied
            && row?.account_membership_migration_applied
            && row?.suitecrm_inbound_sync_migration_applied
            && row?.crm_display_text_migration_applied
            && row?.browser_sessions_migration_applied
            && row?.workspace_preferences_migration_applied
            && row?.pipeline_catalog_migration_applied
            && row?.atomic_product_catalog_migration_applied
            && row?.organization_branding_migration_applied
            && row?.pipeline_spelling_migration_applied
            && row?.residual_pipeline_catalog_migration_applied
            && row?.historical_pipeline_catalog_migration_applied
            && row?.configured_pipeline_dropdowns_migration_applied
            && row?.canonical_dropdown_layout_migration_applied
            && row?.empty_pipeline_templates_migration_applied
            && row?.crm_contact_owner_identity_migration_applied
            && row?.repository_runner_migration_applied
            && row?.crm_employee_identity_migration_applied
            && row?.canonical_suitecrm_usernames_migration_applied
            && row?.agent_research_migration_applied
            && row?.toast_integrations_migration_applied
            && row?.multi_workspace_memberships_migration_applied
            && row?.quickbooks_connector_migration_applied
            && row?.quickbooks_explorer_migration_applied
            && row?.quickbooks_reports_migration_applied
            && row?.quickbooks_write_control_migration_applied
            && row?.demo_quickbooks_crm_migration_applied
            && row?.demo_workspace_account_migration_applied
            && row?.toast_pos_orders_migration_applied
            && row?.quickbooks_write_connection_binding_migration_applied
            && row?.pos_accounting_profiles_migration_applied
            && row?.toast_menu_catalog_migration_applied
            && row?.quickbooks_reference_catalogs_migration_applied
            && row?.toast_sync_rerun_migration_applied
            && row?.toast_sync_worker_hardening_migration_applied
            && row?.pos_accounting_notifications_migration_applied
            && row?.quickbooks_write_binding_compatibility_migration_applied
            && row?.pos_accounting_notification_consent_migration_applied
            && row?.pos_accounting_date_commands_migration_applied
            && row?.pos_accounting_posting_outcomes_migration_applied
            && row?.external_pos_accounting_outcomes_migration_applied
            && row?.distributed_operations_migration_applied
            && row?.migration_checksums_present
          ),
        }
        if (
          !row?.worker_migration_applied
          || !row?.auth_migration_applied
          || !row?.agent_auth_migration_applied
          || !row?.users_migration_applied
          || !row?.attribution_migration_applied
          || !row?.workspaces_migration_applied
          || !row?.workspace_security_migration_applied
          || !row?.agent_dispatch_migration_applied
          || !row?.invitation_migration_applied
          || !row?.knowledge_migration_applied
          || !row?.hardening_migration_applied
          || !row?.invitation_delivery_migration_applied
          || !row?.invitation_pending_migration_applied
          || !row?.shortlinks_migration_applied
          || !row?.vector_knowledge_migration_applied
          || !row?.shortlink_preflight_migration_applied
          || !row?.shortlink_hardening_migration_applied
          || !row?.maton_credentials_migration_applied
          || !row?.managed_pipeline_resources_migration_applied
          || !row?.crm_gateway_migration_applied
          || !row?.crm_identity_hierarchy_migration_applied
          || !row?.pipeline_sheet_links_migration_applied
          || !row?.crm_integrations_migration_applied
          || !row?.crm_board_projection_migration_applied
          || !row?.account_membership_migration_applied
          || !row?.suitecrm_inbound_sync_migration_applied
          || !row?.crm_display_text_migration_applied
          || !row?.browser_sessions_migration_applied
          || !row?.workspace_preferences_migration_applied
          || !row?.pipeline_catalog_migration_applied
          || !row?.atomic_product_catalog_migration_applied
          || !row?.organization_branding_migration_applied
          || !row?.pipeline_spelling_migration_applied
          || !row?.residual_pipeline_catalog_migration_applied
          || !row?.historical_pipeline_catalog_migration_applied
          || !row?.configured_pipeline_dropdowns_migration_applied
          || !row?.canonical_dropdown_layout_migration_applied
          || !row?.empty_pipeline_templates_migration_applied
          || !row?.crm_contact_owner_identity_migration_applied
          || !row?.repository_runner_migration_applied
          || !row?.crm_employee_identity_migration_applied
          || !row?.canonical_suitecrm_usernames_migration_applied
          || !row?.agent_research_migration_applied
          || !row?.toast_integrations_migration_applied
          || !row?.multi_workspace_memberships_migration_applied
          || !row?.quickbooks_connector_migration_applied
          || !row?.quickbooks_explorer_migration_applied
          || !row?.quickbooks_reports_migration_applied
          || !row?.quickbooks_write_control_migration_applied
          || !row?.demo_quickbooks_crm_migration_applied
          || !row?.demo_workspace_account_migration_applied
          || !row?.toast_pos_orders_migration_applied
          || !row?.quickbooks_write_connection_binding_migration_applied
          || !row?.pos_accounting_profiles_migration_applied
          || !row?.toast_menu_catalog_migration_applied
          || !row?.quickbooks_reference_catalogs_migration_applied
          || !row?.toast_sync_rerun_migration_applied
          || !row?.toast_sync_worker_hardening_migration_applied
          || !row?.pos_accounting_notifications_migration_applied
          || !row?.quickbooks_write_binding_compatibility_migration_applied
          || !row?.pos_accounting_notification_consent_migration_applied
          || !row?.pos_accounting_date_commands_migration_applied
          || !row?.pos_accounting_posting_outcomes_migration_applied
          || !row?.external_pos_accounting_outcomes_migration_applied
          || !row?.distributed_operations_migration_applied
          || !row?.migration_checksums_present
        ) {
          errors.push('Required database migrations are not applied.')
        }

        if (
          row?.toast_integrations_migration_applied
          && row?.quickbooks_connector_migration_applied
          && row?.demo_workspace_account_migration_applied
          && row?.quickbooks_write_control_migration_applied
          && row?.quickbooks_write_connection_binding_migration_applied
          && row?.pos_accounting_notifications_migration_applied
          && row?.quickbooks_write_binding_compatibility_migration_applied
          && row?.pos_accounting_notification_consent_migration_applied
          && row?.pos_accounting_date_commands_migration_applied
          && row?.pos_accounting_posting_outcomes_migration_applied
          && row?.external_pos_accounting_outcomes_migration_applied
        ) {
          const queueResult = await query<{
            toast_pending: number
            toast_failed: number
            toast_dead: number
            toast_stale_processing: number
            toast_overdue: number
            quickbooks_pending: number
            quickbooks_failed: number
            quickbooks_dead: number
            quickbooks_stale_processing: number
            quickbooks_overdue: number
            quickbooks_write_processing: number
            quickbooks_write_failed: number
            quickbooks_write_dead: number
            quickbooks_write_stale_processing: number
            quickbooks_write_unbound_active: number
            pos_notification_pending: number
            pos_notification_failed: number
            pos_notification_dead: number
            pos_notification_stale_processing: number
            pos_notification_overdue: number
          }>(
            `WITH toast_queue AS (
               SELECT
                 count(*) FILTER (WHERE job.status = 'pending')::integer AS pending,
                 count(*) FILTER (WHERE job.status = 'failed')::integer AS failed,
                 count(*) FILTER (WHERE job.status = 'dead')::integer AS dead,
                 count(*) FILTER (
                   WHERE job.status = 'processing'
                     AND COALESCE(job.locked_at, job.updated_at) < now() - interval '15 minutes'
                 )::integer AS stale_processing,
                 count(*) FILTER (
                   WHERE job.status IN ('pending', 'failed')
                     AND job.available_at < now() - interval '15 minutes'
                 )::integer AS overdue
               FROM toast_sync_outbox job
               JOIN workspace_organizations organization ON organization.id = job.organization_id
               WHERE organization.is_demo = false
             ), quickbooks_queue AS (
               SELECT
                 count(*) FILTER (WHERE job.status = 'pending')::integer AS pending,
                 count(*) FILTER (WHERE job.status = 'failed')::integer AS failed,
                 count(*) FILTER (WHERE job.status = 'dead')::integer AS dead,
                 count(*) FILTER (
                   WHERE job.status = 'processing'
                     AND COALESCE(job.locked_at, job.updated_at) < now() - interval '15 minutes'
                 )::integer AS stale_processing,
                 count(*) FILTER (
                   WHERE job.status IN ('pending', 'failed')
                     AND job.available_at < now() - interval '15 minutes'
                 )::integer AS overdue
               FROM quickbooks_sync_outbox job
               JOIN workspace_organizations organization ON organization.id = job.organization_id
               WHERE organization.is_demo = false
             ), quickbooks_write_queue AS (
               SELECT
                 count(*) FILTER (WHERE request.status = 'processing')::integer AS processing,
                 count(*) FILTER (WHERE request.status = 'failed')::integer AS failed,
                 count(*) FILTER (WHERE request.status = 'dead')::integer AS dead,
                 count(*) FILTER (
                   WHERE request.status = 'processing'
                     AND COALESCE(request.locked_at, request.updated_at) < now() - interval '15 minutes'
                 )::integer AS stale_processing,
                 count(*) FILTER (
                   WHERE request.reviewed_maton_connection_id IS NULL
                     AND request.status NOT IN ('succeeded', 'cancelled')
                 )::integer AS unbound_active
               FROM quickbooks_write_requests request
               JOIN workspace_organizations organization ON organization.id = request.organization_id
               WHERE organization.is_demo = false
             ), pos_notification_queue AS (
               SELECT
                 count(*) FILTER (WHERE notification.status = 'pending')::integer AS pending,
                 count(*) FILTER (WHERE notification.status = 'failed')::integer AS failed,
                 count(*) FILTER (WHERE notification.status = 'dead')::integer AS dead,
                 count(*) FILTER (
                   WHERE notification.status = 'processing'
                     AND notification.locked_at < now() - interval '15 minutes'
                 )::integer AS stale_processing,
                 count(*) FILTER (
                   WHERE notification.status IN ('pending', 'failed')
                     AND notification.available_at < now() - interval '15 minutes'
                 )::integer AS overdue
               FROM pos_accounting_notification_outbox notification
               JOIN pos_accounting_issue_states issue ON issue.id = notification.issue_state_id
               JOIN workspace_organizations organization ON organization.id = issue.organization_id
               WHERE organization.is_demo = false
             )
             SELECT
               toast_queue.pending AS toast_pending,
               toast_queue.failed AS toast_failed,
               toast_queue.dead AS toast_dead,
               toast_queue.stale_processing AS toast_stale_processing,
               toast_queue.overdue AS toast_overdue,
               quickbooks_queue.pending AS quickbooks_pending,
               quickbooks_queue.failed AS quickbooks_failed,
               quickbooks_queue.dead AS quickbooks_dead,
               quickbooks_queue.stale_processing AS quickbooks_stale_processing,
               quickbooks_queue.overdue AS quickbooks_overdue,
               quickbooks_write_queue.processing AS quickbooks_write_processing,
               quickbooks_write_queue.failed AS quickbooks_write_failed,
               quickbooks_write_queue.dead AS quickbooks_write_dead,
               quickbooks_write_queue.stale_processing AS quickbooks_write_stale_processing,
               quickbooks_write_queue.unbound_active AS quickbooks_write_unbound_active,
               pos_notification_queue.pending AS pos_notification_pending,
               pos_notification_queue.failed AS pos_notification_failed,
               pos_notification_queue.dead AS pos_notification_dead,
               pos_notification_queue.stale_processing AS pos_notification_stale_processing,
               pos_notification_queue.overdue AS pos_notification_overdue
             FROM toast_queue
             CROSS JOIN quickbooks_queue
             CROSS JOIN quickbooks_write_queue
             CROSS JOIN pos_notification_queue`,
          )
          const queue = queueResult.rows[0]
          const queueErrors = Number(queue?.toast_dead || 0)
            + Number(queue?.toast_stale_processing || 0)
            + Number(queue?.toast_overdue || 0)
            + Number(queue?.quickbooks_dead || 0)
            + Number(queue?.quickbooks_stale_processing || 0)
            + Number(queue?.quickbooks_overdue || 0)
            + Number(queue?.quickbooks_write_dead || 0)
            + Number(queue?.quickbooks_write_stale_processing || 0)
            + Number(queue?.quickbooks_write_unbound_active || 0)
            + Number(queue?.pos_notification_dead || 0)
            + Number(queue?.pos_notification_stale_processing || 0)
            + Number(queue?.pos_notification_overdue || 0)
          integrationQueues = {
            status: queueErrors > 0 ? 'error' : 'healthy',
            toast: {
              pending: Number(queue?.toast_pending || 0),
              failed: Number(queue?.toast_failed || 0),
              dead: Number(queue?.toast_dead || 0),
              staleProcessing: Number(queue?.toast_stale_processing || 0),
              overdue: Number(queue?.toast_overdue || 0),
            },
            quickBooks: {
              pending: Number(queue?.quickbooks_pending || 0),
              failed: Number(queue?.quickbooks_failed || 0),
              dead: Number(queue?.quickbooks_dead || 0),
              staleProcessing: Number(queue?.quickbooks_stale_processing || 0),
              overdue: Number(queue?.quickbooks_overdue || 0),
            },
            quickBooksWrites: {
              processing: Number(queue?.quickbooks_write_processing || 0),
              failed: Number(queue?.quickbooks_write_failed || 0),
              dead: Number(queue?.quickbooks_write_dead || 0),
              staleProcessing: Number(queue?.quickbooks_write_stale_processing || 0),
              unboundActive: Number(queue?.quickbooks_write_unbound_active || 0),
            },
            posAccountingNotifications: {
              pending: Number(queue?.pos_notification_pending || 0),
              failed: Number(queue?.pos_notification_failed || 0),
              dead: Number(queue?.pos_notification_dead || 0),
              staleProcessing: Number(queue?.pos_notification_stale_processing || 0),
              overdue: Number(queue?.pos_notification_overdue || 0),
            },
          }
          if (cloudProvider === 'railway') {
            if (Number(queue?.toast_dead || 0) > 0) errors.push('Toast sync queue has terminal failed jobs.')
            if (Number(queue?.toast_stale_processing || 0) > 0) errors.push('Toast sync queue has stale processing jobs.')
            if (Number(queue?.toast_overdue || 0) > 0) errors.push('Toast sync queue has overdue jobs.')
            if (Number(queue?.quickbooks_dead || 0) > 0) errors.push('QuickBooks sync queue has terminal failed jobs.')
            if (Number(queue?.quickbooks_stale_processing || 0) > 0) errors.push('QuickBooks sync queue has stale processing jobs.')
            if (Number(queue?.quickbooks_overdue || 0) > 0) errors.push('QuickBooks sync queue has overdue jobs.')
            if (Number(queue?.quickbooks_write_dead || 0) > 0) errors.push('QuickBooks write queue has terminal failed requests.')
            if (Number(queue?.quickbooks_write_stale_processing || 0) > 0) errors.push('QuickBooks write queue has stale processing requests.')
            if (Number(queue?.quickbooks_write_unbound_active || 0) > 0) errors.push('QuickBooks write queue has requests without a reviewed connection binding.')
            if (Number(queue?.pos_notification_dead || 0) > 0) errors.push('POS accounting notification queue has terminal failed deliveries.')
            if (Number(queue?.pos_notification_stale_processing || 0) > 0) errors.push('POS accounting notification queue has stale processing deliveries.')
            if (Number(queue?.pos_notification_overdue || 0) > 0) errors.push('POS accounting notification queue has overdue deliveries.')
          }
        }

        if (cloudProvider === 'railway') {
          const heartbeat = await readPipelineOutboxWorkerHeartbeatFromPostgres()
          const heartbeatAt = Date.parse(String(heartbeat?.checkedAt || ''))
          const pollMs = Math.max(1000, Math.min(Number(process.env.PIPELINE_OUTBOX_POLL_MS || 10000), 300000))
          const maxHeartbeatAgeMs = Math.max(90_000, pollMs * 3)
          const ageMs = Number.isFinite(heartbeatAt) ? checkedAt - heartbeatAt : null
          worker = {
            status: ageMs !== null && ageMs <= maxHeartbeatAgeMs ? 'reachable' : 'stale',
            heartbeatAt: heartbeat?.checkedAt || null,
            phase: heartbeat?.phase || null,
            ageMs,
          }
          if (ageMs === null || ageMs > maxHeartbeatAgeMs) {
            errors.push('Pipeline outbox worker heartbeat is missing or stale.')
          }

          if (crmEnabled) {
            const crmHeartbeat = await readSuiteCrmWorkerHeartbeat()
            const crmHeartbeatAt = Date.parse(String(crmHeartbeat?.checkedAt || ''))
            const crmAgeMs = Number.isFinite(crmHeartbeatAt) ? checkedAt - crmHeartbeatAt : null
            crm = {
              status: crmAgeMs !== null && crmAgeMs <= maxHeartbeatAgeMs ? 'reachable' : 'stale',
              heartbeatAt: crmHeartbeat?.checkedAt || null,
              phase: crmHeartbeat?.phase || null,
              ageMs: crmAgeMs,
            }
            if (crmAgeMs === null || crmAgeMs > maxHeartbeatAgeMs) {
              errors.push('SuiteCRM outbox worker heartbeat is missing or stale.')
            }
          }

          const agentHeartbeat = await readAgentDispatchWorkerHeartbeatFromPostgres()
          const agentHeartbeatAt = Date.parse(String(agentHeartbeat?.checkedAt || ''))
          const agentPollMs = Math.max(1000, Math.min(Number(process.env.AGENT_DISPATCH_POLL_MS || 5000), 300000))
          const maxAgentHeartbeatAgeMs = Math.max(240_000, agentPollMs * 3)
          const agentAgeMs = Number.isFinite(agentHeartbeatAt) ? checkedAt - agentHeartbeatAt : null
          agentWorker = {
            status: agentAgeMs !== null && agentAgeMs <= maxAgentHeartbeatAgeMs ? 'reachable' : 'stale',
            heartbeatAt: agentHeartbeat?.checkedAt || null,
            phase: agentHeartbeat?.phase || null,
            ageMs: agentAgeMs,
          }
          if (agentAgeMs === null || agentAgeMs > maxAgentHeartbeatAgeMs) {
            errors.push('Agent dispatch worker heartbeat is missing or stale.')
          }

          const researchHeartbeat = await readAgentResearchWorkerHeartbeatFromPostgres()
          const researchHeartbeatAt = Date.parse(String(researchHeartbeat?.checkedAt || ''))
          const researchPollMs = Math.max(5000, Math.min(Number(process.env.AGENT_RESEARCH_POLL_MS || 10000), 300000))
          const maxResearchHeartbeatAgeMs = Math.max(360_000, researchPollMs * 3)
          const researchAgeMs = Number.isFinite(researchHeartbeatAt) ? checkedAt - researchHeartbeatAt : null
          agentResearchWorker = {
            status: researchAgeMs !== null && researchAgeMs <= maxResearchHeartbeatAgeMs ? 'reachable' : 'stale',
            heartbeatAt: researchHeartbeat?.checkedAt || null,
            phase: researchHeartbeat?.phase || null,
            ageMs: researchAgeMs,
          }
          if (researchAgeMs === null || researchAgeMs > maxResearchHeartbeatAgeMs) {
            errors.push('Agent research worker heartbeat is missing or stale.')
          }

          const toastHeartbeat = await readToastWorkerHeartbeatFromPostgres()
          const toastHeartbeatAt = Date.parse(String(toastHeartbeat?.checkedAt || ''))
          const toastPollMs = Math.max(5000, Math.min(Number(process.env.TOAST_SYNC_POLL_MS || 15000), 300000))
          const maxToastHeartbeatAgeMs = Math.max(180_000, toastPollMs * 3)
          const toastAgeMs = Number.isFinite(toastHeartbeatAt) ? checkedAt - toastHeartbeatAt : null
          toastWorker = {
            status: toastAgeMs !== null && toastAgeMs <= maxToastHeartbeatAgeMs ? 'reachable' : 'stale',
            heartbeatAt: toastHeartbeat?.checkedAt || null,
            phase: toastHeartbeat?.phase || null,
            ageMs: toastAgeMs,
          }
          if (toastAgeMs === null || toastAgeMs > maxToastHeartbeatAgeMs) {
            errors.push('Toast sync worker heartbeat is missing or stale.')
          }

          const quickBooksHeartbeat = await readQuickBooksWorkerHeartbeatFromPostgres()
          const quickBooksHeartbeatAt = Date.parse(String(quickBooksHeartbeat?.checkedAt || ''))
          const quickBooksPollMs = Math.max(5000, Math.min(Number(process.env.QUICKBOOKS_SYNC_POLL_MS || 30000), 300000))
          const maxQuickBooksHeartbeatAgeMs = Math.max(180_000, quickBooksPollMs * 3)
          const quickBooksAgeMs = Number.isFinite(quickBooksHeartbeatAt) ? checkedAt - quickBooksHeartbeatAt : null
          quickBooksWorker = {
            status: quickBooksAgeMs !== null && quickBooksAgeMs <= maxQuickBooksHeartbeatAgeMs ? 'reachable' : 'stale',
            heartbeatAt: quickBooksHeartbeat?.checkedAt || null,
            phase: quickBooksHeartbeat?.phase || null,
            ageMs: quickBooksAgeMs,
          }
          if (quickBooksAgeMs === null || quickBooksAgeMs > maxQuickBooksHeartbeatAgeMs) {
            errors.push('QuickBooks sync worker heartbeat is missing or stale.')
          }

          const knowledgeResult = await query<{
            worker_name: string
            checked_at: string
            phase: string
            details: Record<string, unknown>
          }>(
            `SELECT worker_name, checked_at::text, phase, details FROM knowledge_worker_heartbeat ORDER BY worker_name`,
          )
          const radarPollMs = Math.max(60_000, Math.min(Number(process.env.AI_RADAR_POLL_MS || 3_600_000), 86_400_000))
          const embeddingPollMs = Math.max(5_000, Math.min(Number(process.env.DOCUMENT_EMBEDDING_POLL_MS || 15_000), 300_000))
          knowledgeWorkers = knowledgeResult.rows.map((row) => {
            const ageMs = checkedAt - Date.parse(row.checked_at)
            const maxAgeMs = row.worker_name === 'ai-radar'
              ? Math.max(120_000, radarPollMs * 2)
              : Math.max(90_000, embeddingPollMs * 3)
            const fresh = Number.isFinite(ageMs) && ageMs <= maxAgeMs
            return {
              name: row.worker_name,
              status: fresh ? 'reachable' : 'stale',
              phase: row.phase,
              heartbeatAt: row.checked_at,
              ageMs: Number.isFinite(ageMs) ? ageMs : null,
              maxAgeMs,
              details: row.details,
            }
          })
          for (const expectedWorker of ['ai-radar', 'document-embeddings']) {
            const workerStatus = knowledgeWorkers.find((entry) => entry.name === expectedWorker)
            if (!workerStatus) errors.push(`${expectedWorker} worker heartbeat is missing.`)
            else if (workerStatus.status === 'stale') errors.push(`${expectedWorker} worker heartbeat is stale.`)
            else if (workerStatus.phase === 'failed') errors.push(`${expectedWorker} worker reported a failure.`)
            else if (workerStatus.phase === 'degraded') warnings.push(`${expectedWorker} worker is degraded.`)
            if (expectedWorker === 'document-embeddings') {
              const details = workerStatus?.details && typeof workerStatus.details === 'object'
                ? workerStatus.details as Record<string, unknown>
                : {}
              const backlog = details.backlog && typeof details.backlog === 'object'
                ? details.backlog as Record<string, unknown>
                : {}
              if (Number(backlog.terminalFailed || 0) > 0 && workerStatus?.phase !== 'failed') {
                errors.push('document-embeddings worker has terminal failed jobs.')
              }
            }
          }
        }
      } catch (error) {
        database = {
          status: 'unreachable',
        }
        console.error('[health] Postgres health check failed', error)
        errors.push('Postgres is unreachable.')
      }
    } else {
      errors.push('Hosted runtime database is not configured.')
    }

    return NextResponse.json({
      status: errors.length > 0 ? 'error' : 'ok',
      errors,
      warnings,
      runtime: cloudProvider || 'hosted',
      environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.VERCEL_ENV || null,
      storage,
      database,
      credentialStore,
      worker,
      agentWorker,
      agentResearchWorker,
      toastWorker,
      quickBooksWorker,
      integrationQueues,
      crm,
      knowledgeWorkers,
      capabilities: {
        openClawExecution: process.env.CLAWPILOT_EXECUTION_ENABLED === '1',
        agentRuntime: getAgentRuntime(),
        semanticDocumentSearch: embeddingProvider === 'openai',
        vectorDocumentSearch: true,
        aiRadar: process.env.AI_RADAR_ENABLED !== 'false',
        shortLinks: true,
        crm: process.env.CRM_ENABLED === '1',
        toast: true,
        quickBooks: true,
        repositoryRunner: {
          enabled: repositoryRunner.enabled,
          ready: repositoryRunner.ready,
          reason: repositoryRunner.reason,
          repository: repositoryRunner.repositoryFullName,
          baseBranch: repositoryRunner.baseBranch,
          patchOnly: true,
        },
      },
      checkedAt,
    }, { status: errors.length > 0 ? 503 : 200 })
  }

  const logSource = resolveLogPath()

  try {
    const stat = fs.statSync(logSource.path)
    if (checkedAt - stat.mtimeMs > WINDOW_MS) {
      return NextResponse.json({
        status: logSource.usedFallback ? 'degraded' : 'ok',
        errors: [],
        warnings: logSource.usedFallback ? ['Expected dev log missing; using fallback runtime log.'] : [],
        logPath: logSource.path,
        expectedDevLogPresent: logSource.expectedDevLogPresent,
        usedFallbackLog: logSource.usedFallback,
        lastModified: stat.mtimeMs,
        checkedAt,
      })
    }

    const raw = readLogTailUtf8(logSource.path, MAX_BYTES_TO_SCAN)
    const lines = raw.split('\n')

    const startupIndex = lines.reduce((latest, line, index) => (
      line.includes('Ready in') || line.includes('Starting...') ? index : latest
    ), -1)
    const recent = (startupIndex >= 0 ? lines.slice(startupIndex) : lines).slice(-200)
    const errors = recent.filter(l => ERROR_PATTERNS.some(p => p.test(l)))

    return NextResponse.json({
      status: errors.length > 0 ? 'error' : (logSource.usedFallback ? 'degraded' : 'ok'),
      errors: errors.slice(-10), // last 10 errors
      warnings: logSource.usedFallback ? ['Expected dev log missing; using fallback runtime log.'] : [],
      logPath: logSource.path,
      expectedDevLogPresent: logSource.expectedDevLogPresent,
      usedFallbackLog: logSource.usedFallback,
      lastModified: stat.mtimeMs,
      checkedAt,
      scannedBytes: Math.min(stat.size, MAX_BYTES_TO_SCAN),
    })
  } catch {
    return NextResponse.json({
      status: 'degraded',
      errors: [],
      warnings: ['Unable to read expected runtime log. Health is best-effort only.'],
      logPath: logSource.path,
      expectedDevLogPresent: logSource.expectedDevLogPresent,
      usedFallbackLog: logSource.usedFallback,
      checkedAt,
    })
  }
}
