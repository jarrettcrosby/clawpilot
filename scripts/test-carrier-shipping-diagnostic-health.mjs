#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const routePath = 'app_src/app/api/health/route.ts'
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

const health = readFileSync(
  resolve(process.cwd(), 'app_src/app/api/health/route.ts'),
  'utf8',
)

const required0285Structure = [
  '0285_shopify_carrier_service_configured_carriers.sql',
  'operations_shopify_carrier_service_config_carriers_pkey',
  'PRIMARY KEY (organization_id, config_id, carrier_account_id)',
  'operations_shopify_checkout_rate_receipt_provider_attempts_pkey',
  'PRIMARY KEY (organization_id, receipt_id, carrier_account_id)',
  'operations_pack_rate_run_rate_choices_pkey',
  'PRIMARY KEY (organization_id, id)',
  'operations_fulfillment_execution_rate_attempts_pkey',
  'PRIMARY KEY (organization_id, execution_id, carrier_account_id)',
  'operations_pack_rate_choices_account_service_unique',
  "'organization_id', 'run_id', 'carrier_account_id'",
  "'(carrier_account_id IS NOT NULL)'",
  'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)',
  'operations_shopify_carrier_configuration_allows_rating(jsonb,text)',
  'operations_pack_rate_runs_selected_carrier_account_fkey',
  'operations_pack_rate_run_rate_choices_account_fkey',
  'operations_shipment_groups_selected_carrier_account_fkey',
  'operations_shipment_groups_run_account_fkey',
  'operations_fulfillment_rate_attempts_account_fkey',
  'derive_operations_legacy_pack_rate_run_account()',
  'derive_operations_legacy_pack_rate_choice_account()',
  'derive_operations_legacy_shipment_group_account()',
  'validate_operations_pack_rate_account_lineage_complete()',
  'validate_operations_fulfillment_account_lineage_complete()',
  'protect_op_shopify_checkout_provider_attempt()',
  'validate_op_shopify_checkout_attempt_finalization()',
  'validate_operations_fulfillment_execution()',
  'validate_operations_fulfillment_label_attempt_link_deferred',
  'validate_operations_fulfillment_label_link_deferred',
  'validate_operations_fulfillment_shipment_link_deferred',
  'derive_operations_legacy_shopify_carrier_selection_key_write',
  'operations_legacy_shopify_receipt_offer_carrier_account_id(uuid,text,text,text,text,bigint,text)',
  'operations_legacy_shopify_config_carrier_account_id(uuid,text,text)',
  'operations_legacy_shopify_fulfillment_attempt_carrier_account_id(uuid,uuid,text,boolean)',
  'NEW.actor_email IS NOT NULL',
  'validate_one_off_rate_selection_key_write',
  'validate_one_off_rate_selection_key()',
  'protect_operations_shopify_checkout_rate_receipt_offer_write',
  "requested_environment IN (''sandbox'', ''production'')",
  'carrier_integration.environment = requested_environment',
  'selected.carrier_account_id = NEW.carrier_account_id',
  'rate_evidence.carrier_selection_key IS DISTINCT FROM operations_shopify_checkout_carrier_selection_key(',
  'installed_shopify_carrier_trigger.tgconstraint = 0',
  'installed_shopify_carrier_constraint.condeferrable',
  'installed_shopify_carrier_constraint.condeferred',
]

const required0286Structure = [
  '0286_carrier_shipping_account_diagnostics.sql',
  'carrier_shipping_diagnostics_applied',
  'validate_operations_carrier_shipping_diagnostic_lineage()',
  'validate_operations_carrier_shipping_diagnostic_label',
  'validate_operations_carrier_shipping_diagnostic_attempt',
  'operations_carrier_rate_test_attempts_health_recent_idx',
  'operations_carrier_test_attempts_live_account_open_unique',
  'operations_carrier_test_labels_live_account_active_unique',
  'production_shipping_diagnostic_lease_count',
  'operations_activation_scopes_shipping_diagnostic_lease_valid',
  'operations_integration_accounts_shipping_diagnostic_lease_valid',
  'operations_carrier_credentials_shipping_diagnostic_lease_valid',
  'operations_carrier_accounts_shipping_diagnostic_lease_valid',
  'maintain_operations_carrier_shipping_diagnostic_authority_lease()',
  'protect_operations_carrier_shipping_diagnostic_authority()',
  'protect_operations_carrier_shipping_diagnostic_activation',
  'protect_operations_carrier_shipping_diagnostic_integration',
  'protect_operations_carrier_shipping_diagnostic_credential',
  'protect_operations_carrier_shipping_diagnostic_account',
  'FOR UPDATE OF integration, credential, carrier_account, activation',
  'credentialFingerprint',
  'accountNumberFingerprint',
  'registeredAddressFingerprint',
  'senderName',
  'NEW.credential_ciphertext',
  'NEW.credential_fingerprint',
  'NEW.account_number_ciphertext',
  'NEW.account_number_last_four',
  'NEW.registered_address',
  'NEW.sender_name',
  'LIMIT 500',
  "evidence.purpose = ''shipping_account_diagnostic''",
  'evidence.integration_account_id <> NEW.integration_account_id',
  'evidence.carrier_account_id <> NEW.carrier_account_id',
  "NEW.environment IN (''sandbox'', ''production'')",
  "NEW.environment = ''sandbox''",
  'label.account_number_fingerprint = carrier_account.account_number_fingerprint',
  "integration.environment = ''sandbox''",
  'carrier_shipping_diagnostic_attempt_counts',
  "'sandbox' | 'production'",
  'stalePrepared',
  'unknown provider outcomes requiring manual review; do not retry',
]

for (const fragment of [...required0285Structure, ...required0286Structure]) {
  assert.ok(health.includes(fragment), `Health route missing ${fragment}`)
}

assert.ok(
  (health.match(/row\?\.shopify_carrier_configured_carriers_applied/g) || [])
    .length >= 2,
  '0285 structural drift must fail migrationsCurrent and global health',
)
assert.ok(
  (health.match(/row\?\.carrier_shipping_diagnostics_applied/g) || [])
    .length >= 3,
  '0286 structural drift must fail migrationsCurrent and global health',
)
assert.match(
  health,
  /installed_diagnostic_trigger\.tgenabled = 'O'/,
  'Both 0286 lineage triggers must be enabled in origin mode',
)
assert.match(
  health,
  /installed_shopify_carrier_trigger\.tgenabled = 'O'/,
  '0285 lineage/finalizer triggers must be enabled in origin mode',
)

console.log('Carrier shipping diagnostic health attestation passed.')

function loadHealthRoute({ configuredCarriersApplied, diagnosticsApplied }) {
  const now = new Date().toISOString()
  const mainRow = new Proxy({ now }, {
    get(target, property) {
      if (property in target) return target[property]
      if (property === 'shopify_carrier_configured_carriers_applied') {
        return configuredCarriersApplied
      }
      if (property === 'carrier_shipping_diagnostics_applied') {
        return diagnosticsApplied
      }
      if (property === 'carrier_shipping_diagnostic_attempt_counts') {
        return {
          sandbox: {
            prepared: 0,
            stalePrepared: 0,
            succeeded: 0,
            failed: 0,
            unknown: 0,
          },
          production: {
            prepared: 0,
            stalePrepared: 0,
            succeeded: 0,
            failed: 0,
            unknown: 0,
          },
        }
      }
      if (
        typeof property === 'string'
        && (property.endsWith('_applied') || property.endsWith('_present'))
      ) return true
      return undefined
    },
  })
  const query = async (sql) => {
    const statement = String(sql)
    if (statement.includes('AS carrier_shipping_diagnostics_applied')) {
      return { rows: [mainRow] }
    }
    return { rows: [{}] }
  }
  const canonicalHealth = {
    status: 'ready',
    expiredProtectedReadBacklog: 0,
    protectedEvidenceKeys: { ready: true },
    summary: {},
  }
  const orderHistory = {
    transport: 'polling',
    continuousTransportCounts: {},
    pollingCadenceMinutes: 5,
    staleProcessing: 0,
    failed: 0,
    blocked: 0,
    dead: 0,
    overduePolls: 0,
    expiredSensitiveEvidence: 0,
  }
  const runtime = Object.freeze({
    available: false,
    mode: null,
    blockerCode: 'SHOPIFY_ORDER_TEST_WRITES_RAILWAY_OR_LOCAL_ONLY',
    allowedAccountGlobalIds: Object.freeze([]),
    providerWritesEnabled: false,
    productionAvailable: false,
  })
  const moduleMocks = {
    'next/server': {
      NextResponse: {
        json(body, init = {}) {
          return {
            body,
            status: init.status || 200,
            async json() {
              return body
            },
          }
        },
      },
    },
    '@/lib/agents/provider': {
      getAgentRuntime: () => ({ provider: 'test' }),
    },
    '@/lib/agents/repositoryRunnerConfig': {
      getRepositoryRunnerConfiguration: () => ({
        enabled: false,
        ready: true,
        reason: null,
        repositoryFullName: null,
        baseBranch: null,
      }),
    },
    '@/lib/persistence/config': {
      getStorageDriver: () => 'postgres',
      isHostedRuntime: () => true,
    },
    '@/lib/persistence/agentCredentials': {
      query: async () => ({ rows: [{ operator_id: 'operator' }] }),
    },
    '@/lib/persistence/postgres': { query },
    '@/lib/persistence/operationsCommandReceiptHealth': {
      OPERATIONS_COMMAND_RECEIPT_HEALTH_QUERY: 'command receipt health',
    },
    '@/lib/persistence/commerceOrderRevisions': {
      readCommerceOrderRevisionHealthFromPostgres: async () => canonicalHealth,
    },
    '@/lib/persistence/commerceOrderSync': {
      readCommerceOrderSyncHealthFromPostgres: async () => orderHistory,
      readCommerceOrderSyncCursorKeyReadinessFromPostgres: async () => ({
        ready: true,
      }),
    },
    '@/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs': {
      CommerceOrderRevisionEvidenceKeyConfigError: class extends Error {},
      resolveCommerceOrderRevisionEvidenceKeyConfig: () => ({}),
      summarizeCommerceOrderRevisionEvidenceKeyReadiness: () => ({
        ready: true,
        activeKeyId: null,
        configuredKeyIds: [],
      }),
    },
    '@/lib/persistence/shopifyWebhookReceiptHealth': {
      readShopifyWebhookReceiptHealthFromPostgres: async () => ({
        status: 'ready',
        actionable: 0,
      }),
    },
    '@/lib/persistence/shopifyOrderWebhookSignals': {
      readShopifyOrderWebhookSignalHealthFromPostgres: async () => ({
        staleProcessing: 0,
        failed: 0,
        dead: 0,
        overdueDirty: 0,
      }),
    },
    '@/lib/persistence/shopifyOrderManagement': {
      readShopifyOrderManagementHealthFromPostgres: async () => ({
        prepared: 0,
        processing: 0,
        staleProcessing: 0,
        unknown: 0,
        latestUnknownAt: null,
        lastCompletedAt: null,
        knownProviderWriteOutcomeCount: 0,
        knownProviderWriteSum: 0,
      }),
    },
    '@/lib/integrations/shopifyOrderManagementRuntime': {
      shopifyOrderManagementRuntime: () => runtime,
    },
    '@/lib/integrations/commerceIntake': {
      commerceReadRuntimeAvailable: () => false,
    },
    '@/lib/integrations/commerceReadRuntime': {
      commerceReadAccountSql: () => 'true',
      commerceReadRuntimeSummary: () => ({ status: 'disabled' }),
    },
    '@/lib/integrations/commerceOrderHistoryHealth': {
      commerceOrderHistoryDurableDegraded: () => false,
      commerceOrderHistoryOperationalHealth: () => ({
        status: 'disabled',
        runtimeAvailable: false,
        worker: { status: 'disabled' },
      }),
    },
    '@/lib/integrations/commerceFaireAutomaticPromotion': {
      faireAutomaticExactRefreshHealthSnapshot: () => ({ status: 'disabled' }),
      faireAutomaticOrderPromotionHealthSnapshot: () => ({ status: 'disabled' }),
      faireUnattributedAttentionHealthSnapshot: () => ({ status: 'disabled' }),
    },
    '@/lib/integrations/commerceShopifyAutomaticPromotion': {
      shopifyAutomaticOrderPromotionHealthSnapshot: () => ({
        status: 'disabled',
      }),
    },
    '@/lib/documentEmbeddings': {
      effectiveDocumentEmbeddingConfiguration: async () => ({
        provider: 'local',
      }),
    },
    '@/lib/shortlinks': {
      validateShortLinkConfiguration: () => {},
    },
    '@/lib/crm/suiteCrmClient': {
      suiteCrmBaseUrl: () => 'https://crm.invalid',
    },
    '@/lib/crm/suiteCrmProductImageReadClient': {
      suiteCrmProductImageReadConfiguration: () => ({
        enabled: false,
        ready: false,
        missing: [],
        invalid: [],
        credentialConflicts: [],
        aclAttestation: null,
        acl: [],
      }),
    },
    '@/lib/crm/suiteCrmNativeProductImageClient': {
      suiteCrmNativeProductImageProjectionConfiguration: () => ({
        enabled: false,
        ready: false,
        missing: [],
        invalid: [],
      }),
    },
    '@/lib/operations/fulfillmentOptimizerRuntimeConfig': {
      fulfillmentOptimizerRuntimeHealth: () => ({
        configurationStatus: 'ready',
        reason: null,
      }),
    },
  }
  const inertModule = new Proxy({}, {
    get() {
      return async () => null
    },
  })
  const output = ts.transpileModule(health, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: routePath,
  }).outputText
  const loaded = { exports: {} }
  const secret = 'secret-health-sentinel-1234567890-abcdefghijk'
  vm.runInNewContext(output, {
    Array,
    Boolean,
    Buffer,
    Date,
    Error,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    String,
    URL,
    console: { error() {} },
    exports: loaded.exports,
    module: loaded,
    process: {
      env: {
        VERCEL: '1',
        VERCEL_ENV: 'preview',
        APP_AUTH_REQUIRED: '1',
        APP_LOGIN_PASSWORD: 'password-long-enough-for-health',
        APP_LOGIN_EMAIL: 'operator@example.com',
        APP_SESSION_SECRET: secret,
        AGENT_CREDENTIAL_ENCRYPTION_KEY: secret,
        AGENT_CREDENTIAL_DATABASE_URL:
          'postgresql://health:health@database.invalid/health',
        MATON_API_KEY: 'maton-health-key-long-enough',
        MATON_GMAIL_CONNECTION_ID: 'gmail-health',
        CLAWPILOT_MAIL_FROM: 'clawpilot@example.com',
        CLAWPILOT_PUBLIC_URL: 'https://clawpilot.example.com',
        PIPELINE_SHEET_ID: 'pipeline-sheet-health-1234567890',
        CRM_ENABLED: '0',
      },
    },
    require(specifier) {
      if (specifier === 'fs') return requireFromApp('fs')
      return moduleMocks[specifier] || inertModule
    },
  }, { filename: routePath })
  return loaded.exports.GET
}

for (const structuralDrift of [
  {
    name: '0285 trigger or function body drift',
    configuredCarriersApplied: false,
    diagnosticsApplied: true,
  },
  {
    name: '0286 diagnostic lineage drift',
    configuredCarriersApplied: true,
    diagnosticsApplied: false,
  },
]) {
  const GET = loadHealthRoute(structuralDrift)
  const response = await GET()
  const body = JSON.parse(JSON.stringify(await response.json()))
  assert.equal(response.status, 503, `${structuralDrift.name} must return 503`)
  assert.equal(body.status, 'error')
  assert.ok(body.errors.includes('Required database migrations are not applied.'))
  assert.equal(body.database.migrationsCurrent, false)
}

console.log('Carrier shipping diagnostic health 503 regressions passed.')
