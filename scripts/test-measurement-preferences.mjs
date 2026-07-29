#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8')

const migration = read('db/migrations/0125_measurement_preferences.sql')
assert.match(migration, /CREATE TABLE IF NOT EXISTS workspace_organization_preferences/)
assert.match(migration, /organization_id uuid PRIMARY KEY/)
assert.match(migration, /measurement_system text NOT NULL DEFAULT 'imperial'/)
assert.match(migration, /measurement_system IN \('imperial', 'metric'\)/)
assert.match(migration, /revision bigint NOT NULL DEFAULT 1/)
assert.match(migration, /INSERT INTO workspace_organization_preferences/)
assert.match(migration, /FROM workspace_organizations organization/)
assert.match(migration, /ADD COLUMN IF NOT EXISTS measurement_system_override text/)
assert.match(migration, /measurement_system_override IS NULL/)

const currencyMigration = read('db/migrations/0127_workspace_currency_preference.sql')
assert.match(currencyMigration, /ADD COLUMN IF NOT EXISTS currency_code text/)
assert.match(currencyMigration, /SET currency_code = 'USD'/)
assert.match(currencyMigration, /ALTER COLUMN currency_code SET DEFAULT 'USD'/)
assert.match(currencyMigration, /workspace_organization_preferences_currency_code_valid/)
assert.match(currencyMigration, /'currencyCode', upper\(product\.currency\)/)
assert.match(currencyMigration, /crm:products:currency-projection:v1/)
assert.doesNotMatch(currencyMigration, /SET\s+(price|cost|currency)\s*=/i)

const persistence = read('app_src/lib/persistence/measurementPreferences.ts')
assert.match(persistence, /app_user_organization_memberships/)
assert.match(persistence, /membership\.user_email = \$1/)
assert.match(persistence, /membership\.organization_id = \$2::uuid/)
assert.match(persistence, /membership\.status = 'active'/)
assert.match(
  persistence,
  /ON CONFLICT \(user_email, workspace_organization_id\) DO UPDATE SET/,
)
assert.match(persistence, /effectiveAuthorizationRole\(input\.actor\)/)
assert.match(persistence, /role !== 'owner' && role !== 'admin'/)
assert.match(persistence, /AND revision = \$4/)
assert.match(persistence, /organization_revision_conflict/)
assert.match(persistence, /recordAuditEvent/)
assert.match(persistence, /organizationCurrencyCode/)
assert.match(persistence, /updateOrganizationCurrencyCode/)
assert.match(persistence, /organization\.currency_preference\.updated/)

const route = read('app_src/app/api/settings/measurement-preferences/route.ts')
assert.match(route, /requireRequestUser\(req\)/)
assert.match(route, /set-user-override/)
assert.match(route, /set-organization-default/)
assert.match(route, /expectedRevision/)
assert.match(route, /set-organization-currency/)
assert.match(
  route,
  /set-organization-currency[\s\S]*canManageOrganizationDefault\(actor\)[\s\S]*resolveSuiteCrmCurrencyId\(currencyCode\)/,
)
assert.match(route, /resolveSuiteCrmCurrencyId\(currencyCode\)/)
assert.match(route, /suitecrm_currency_configuration_required/)
assert.match(route, /Cache-Control': 'private, no-store/)
assert.doesNotMatch(route, /body\.organizationId/)

const provider = read('app_src/components/measurements/MeasurementSystemProvider.tsx')
assert.match(provider, /\/api\/settings\/measurement-preferences/)
assert.match(provider, /WORKSPACE_CHANGED_EVENT/)
assert.match(provider, /refresh\(true\)/)
assert.match(provider, /setPreferences\(FALLBACK_PREFERENCES\)/)
assert.match(provider, /persistenceEnabled = true/)
assert.match(provider, /if \(!persistenceEnabled\)/)
assert.match(provider, /active_workspace_required/)
assert.match(provider, /preferencesWritable/)
assert.match(provider, /if \(!preferencesWritable\) return/)
assert.match(provider, /setUserOverride/)
assert.match(provider, /setOrganizationDefault/)
assert.match(provider, /organizationCurrencyCode/)
assert.match(provider, /setOrganizationCurrencyCode/)

const panel = read('app_src/components/settings/MeasurementPreferencesPanel.tsx')
assert.match(panel, /organizationName/)
assert.match(panel, /Save default/)
assert.match(panel, /organizationDraft === organizationDefault/)
assert.match(panel, /disabled=\{!preferencesWritable/)
assert.match(panel, /No active organization is available/)
assert.match(panel, /Organization currency/)
assert.match(panel, /Shopify, Faire, carrier, and imported/)
assert.match(panel, /root-organization ClawPilot owner or administrator/)
assert.match(panel, /CRM &gt; Access SuiteCRM/)

const currencyHelpers = read('app_src/lib/currency.ts')
assert.match(currencyHelpers, /SUPPORTED_ISO_4217_CURRENCY_CODES/)
assert.doesNotMatch(currencyHelpers, /supportedValuesOf/)

const crmRoute = read('app_src/app/api/crm/route.ts')
assert.match(crmRoute, /readMeasurementPreferences\(actor\)/)
assert.match(crmRoute, /existingCurrency/)
assert.match(crmRoute, /Product currency must be a supported ISO 4217 code/)

const crmPanel = read('app_src/components/crm/CrmSection.tsx')
assert.match(crmPanel, /organizationCurrencyCode/)
assert.match(crmPanel, /record \? '' : defaultCurrencyCode/)
assert.match(crmPanel, /currencyPreferenceReady/)
assert.match(crmPanel, /Loading the organization currency before a new Product can be added/)
assert.match(crmPanel, /refreshMeasurementPreferences/)
assert.match(
  crmPanel,
  /disabled=\{entity === 'products' && !currencyPreferenceReady\}/,
)

const catalogRoute = read('app_src/app/api/pipeline/catalog/route.ts')
assert.match(catalogRoute, /preferences\.organizationCurrencyCode/)
assert.match(catalogRoute, /defaultCurrencyCode,/)
assert.match(catalogRoute, /fields: productFields\(body\)/)

const crmPersistence = read('app_src/lib/persistence/crm.ts')
assert.match(
  crmPersistence,
  /clean\(input\.fields\.currency\)\.toUpperCase\(\)[\s\S]*clean\(row\?\.currency\)\.toUpperCase\(\)[\s\S]*requestedDefaultCurrency/,
)
assert.match(
  crmPersistence,
  /SELECT currency_code[\s\S]*FROM workspace_organization_preferences[\s\S]*currency: organizationCurrencyCode/,
)

const catalogPanel = read('app_src/components/pipeline/PipelineCatalogDialog.tsx')
assert.match(
  catalogPanel,
  /downloadCsvTemplate\(tab, organizationCurrencyCode\)/,
)
assert.match(
  catalogPanel,
  /disabled=\{tab === 'products' && !currencyPreferenceReady\}/,
)
assert.match(
  catalogPanel,
  /\(!product\.id && !currencyPreferenceReady\)/,
)
assert.match(
  catalogPanel,
  /Loading the organization currency before Product defaults are available/,
)
assert.match(catalogPanel, /refreshMeasurementPreferences/)

const page = read('app_src/app/page.tsx')
assert.match(
  page,
  /<MeasurementSystemProvider persistenceEnabled=\{postgresStorageEnabled\}>/,
)
assert.match(page, /<\/MeasurementSystemProvider>/)
assert.match(page, /const postgresStorageEnabled = getStorageDriver\(\) === 'postgres'/)

const inventoryPanel = read(
  'app_src/components/operations/ShopifyInventoryPanel.tsx',
)
assert.match(inventoryPanel, /!preferencesWritable/)
assert.match(inventoryPanel, /System default · no active organization/)

const health = read('app_src/app/api/health/route.ts')
assert.match(health, /filename = '0125_measurement_preferences\.sql'/)
assert.equal(
  health.match(/measurement_preferences_migration_applied/g)?.length,
  4,
  'health must type, select, require, and report the measurement migration',
)
assert.equal(
  health.match(/packaging_material_unit_neutral_names_migration_applied/g)?.length,
  4,
  'health must type, select, require, and report the starter-name correction',
)
assert.equal(
  health.match(/workspace_currency_preference_migration_applied/g)?.length,
  4,
  'health must type, select, require, and report the workspace currency migration',
)

const predeploy = read('scripts/verify-predeploy.mjs')
for (const requiredPath of [
  'db/migrations/0125_measurement_preferences.sql',
  'db/migrations/0126_packaging_material_unit_neutral_names.sql',
  'db/migrations/0127_workspace_currency_preference.sql',
  'scripts/test-measurement-preferences.mjs',
  'app_src/app/api/settings/measurement-preferences/route.ts',
  'app_src/components/measurements/MeasurementSystemProvider.tsx',
  'app_src/lib/measurements.ts',
  'app_src/lib/currency.ts',
  'app_src/lib/persistence/measurementPreferences.ts',
  'app_src/tests/measurements/measurements.test.ts',
]) {
  assert.match(predeploy, new RegExp(requiredPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
}

const packageJson = JSON.parse(read('package.json'))
assert.match(packageJson.scripts['test:measurement-preferences'], /measurements\.test\.ts/)
assert.match(packageJson.scripts['test:measurement-preferences'], /test-measurement-preferences\.mjs/)
assert.match(packageJson.scripts.test, /test:measurement-preferences/)

const contract = read('docs/modules/distributed-operations.md')
assert.match(contract, /nullable per-user-per-workspace override/)
assert.match(contract, /no active organization uses the compatibility fallback without a persistence request/)
assert.match(contract, /canonical integer millimeters/)
assert.match(contract, /existing warehouse-capacity volume and weight remain cubic meters and kilograms/)
assert.match(contract, /`0125` adds only the tenant-safe organization\/user preference store/)
assert.match(contract, /`0127` adds the organization ISO 4217 default/)

console.log('measurement preference contract checks passed')
