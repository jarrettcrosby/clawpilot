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

const route = read('app_src/app/api/settings/measurement-preferences/route.ts')
assert.match(route, /requireRequestUser\(req\)/)
assert.match(route, /set-user-override/)
assert.match(route, /set-organization-default/)
assert.match(route, /expectedRevision/)
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

const panel = read('app_src/components/settings/MeasurementPreferencesPanel.tsx')
assert.match(panel, /organizationName/)
assert.match(panel, /Save default/)
assert.match(panel, /organizationDraft === organizationDefault/)
assert.match(panel, /disabled=\{!preferencesWritable/)
assert.match(panel, /No active organization is available/)

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

const predeploy = read('scripts/verify-predeploy.mjs')
for (const requiredPath of [
  'db/migrations/0125_measurement_preferences.sql',
  'db/migrations/0126_packaging_material_unit_neutral_names.sql',
  'scripts/test-measurement-preferences.mjs',
  'app_src/app/api/settings/measurement-preferences/route.ts',
  'app_src/components/measurements/MeasurementSystemProvider.tsx',
  'app_src/lib/measurements.ts',
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

console.log('measurement preference contract checks passed')
