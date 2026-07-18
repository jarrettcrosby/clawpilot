import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const migrationPath = 'db/migrations/0041_dashboard_workspace_preferences.sql'
assert.ok(fs.existsSync(path.join(root, migrationPath)), `${migrationPath} must exist`)

const migration = read(migrationPath)
assert.match(migration, /CREATE TABLE IF NOT EXISTS app_user_workspace_preferences/i)
assert.match(migration, /user_email\s+text\s+PRIMARY KEY\s+REFERENCES\s+app_users\s*\(\s*email\s*\)\s+ON DELETE CASCADE/i)
assert.match(migration, /default_board_id\s+uuid\s+REFERENCES\s+project_boards\s*\(\s*id\s*\)\s+ON DELETE SET NULL/i)
assert.match(migration, /default_pipeline_id\s+uuid\s+REFERENCES\s+pipeline_spaces\s*\(\s*id\s*\)\s+ON DELETE SET NULL/i)

const dashboard = read('app_src/components/dashboard/DashboardSection.tsx')
assert.ok(dashboard.includes('/api/workspaces?dashboard=true'), 'dashboard must request its per-user workspace defaults')
assert.match(dashboard, /new URLSearchParams\(\{ includeCrmCards: ['"]true['"] \}\)/, 'dashboard task requests must include CRM cards')
assert.match(dashboard, /params\.set\(['"]boardId['"], boardId\)/, 'dashboard task requests must include an explicit boardId')
assert.match(dashboard, /params\.set\(['"]pipelineId['"], pipelineId\)/, 'dashboard pipeline requests must include an explicit pipelineId')
assert.match(dashboard, /return `\/api\/tasks\?\$\{params\.toString\(\)\}`/, 'dashboard must request tasks with its scoped query')
assert.match(dashboard, /`\/api\/pipeline\?\$\{query\}`/, 'dashboard must request a scoped pipeline snapshot')
assert.match(dashboard, /setDefault\s*:\s*true/, 'dashboard workspace selections must be durable defaults')
assert.match(dashboard, /['"]select-board['"]/, 'dashboard must persist board selection')
assert.match(dashboard, /['"]select-pipeline['"]/, 'dashboard must persist pipeline selection')
assert.match(dashboard, /import Skeleton from ['"]@mui\/material\/Skeleton['"]/, 'dashboard must use the stable Skeleton loading shell')
assert.match(dashboard, /if\s*\(loading\)/, 'dashboard must retain an explicit loading shell')
assert.match(dashboard, /<Skeleton\b/, 'dashboard loading shell must render Skeleton content')
assert.doesNotMatch(dashboard, /CircularProgress/, 'dashboard loading must not collapse to a spinner')
assert.doesNotMatch(dashboard, /(?:window\.)?location\.reload\s*\(/, 'dashboard selection must update without a full-page reload')
assert.match(dashboard, /label:\s*['"]Agent attention['"]/, 'dashboard must expose an actionable agent metric')
assert.match(dashboard, /executionStatus === ['"]blocked['"] \|\| executionStatus === ['"]awaiting_input['"]/, 'agent attention must count tasks that need operator action')
assert.doesNotMatch(dashboard, /Agent results/, 'dashboard must not present the historical execution row count as actionable')
assert.doesNotMatch(dashboard, /execution-results\/summary/, 'dashboard must not fetch the historical execution row count')

const workspaceRoute = read('app_src/app/api/workspaces/route.ts')
assert.match(workspaceRoute, /searchParams\.get\(['"]dashboard['"]\)/, 'workspace API must recognize dashboard preference reads')
assert.match(workspaceRoute, /setDefault/, 'workspace API must recognize durable dashboard selections')

const workspaceSelector = read('app_src/components/workspaces/WorkspaceSelector.tsx')
assert.match(workspaceSelector, /url\.searchParams\.set\(kind, id\)/, 'workspace selector must keep the selected resource in the URL')
assert.match(workspaceSelector, /window\.location\.assign\(url\.toString\(\)\)/, 'workspace selector must reload through the corrected URL')
assert.doesNotMatch(workspaceSelector, /window\.location\.reload\(\)/, 'workspace selector must not retain stale route parameters')

const taskRoute = read('app_src/app/api/tasks/route.ts')
assert.match(taskRoute, /searchParams\.get\(['"]boardId['"]\)/, 'task API must accept an explicit boardId')
assert.match(taskRoute, /searchParams\.get\(['"]includeCrmCards['"]\)/, 'task API must accept the CRM-card count flag')

const pipelineRoute = read('app_src/app/api/pipeline/route.ts')
assert.match(pipelineRoute, /searchParams\.get\(['"]pipelineId['"]\)/, 'pipeline API must accept an explicit pipelineId')

const healthRoute = read('app_src/app/api/health/route.ts')
const healthAlias = healthRoute.match(
  /WHERE filename = ['"]0041_dashboard_workspace_preferences\.sql['"][\s\S]{0,160}?\)\s+AS\s+([a-z0-9_]+)/i,
)?.[1]
assert.ok(healthAlias, 'health must query the 0041 migration')
const healthChecks = healthRoute.match(new RegExp(`row\\?\\.${healthAlias}`, 'g')) || []
assert.ok(healthChecks.length >= 2, 'health must require 0041 for current migrations and report it when missing')

const predeploy = read('scripts/verify-predeploy.mjs')
assert.match(
  predeploy,
  /['"]db\/migrations\/0041_dashboard_workspace_preferences\.sql['"]/,
  'predeploy must require the 0041 migration file',
)

const packageJson = JSON.parse(read('package.json'))
assert.equal(
  packageJson.scripts['test:dashboard-workspace-preferences'],
  'node scripts/test-dashboard-workspace-preferences.mjs',
)
assert.match(packageJson.scripts.test, /npm run test:dashboard-workspace-preferences/)

console.log('dashboard workspace preference contract tests passed')
