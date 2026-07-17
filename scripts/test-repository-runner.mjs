#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const includes = (source, expected, label) => assert.ok(source.includes(expected), `${label} is missing ${expected}`)

const migration = read('db/migrations/0055_repository_runner_control_plane.sql')
includes(migration, 'CREATE TABLE IF NOT EXISTS repository_bindings', 'repository migration')
includes(migration, 'CREATE TABLE IF NOT EXISTS repository_runs', 'repository migration')
includes(migration, "'patch_ready', 'policy_rejected', 'failed', 'cancelled'", 'terminal lifecycle')
includes(migration, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_repository_runs_active_task', 'single active run invariant')
includes(migration, "WHERE status IN ('queued', 'dispatching', 'dispatched', 'running')", 'active run predicate')

const configuration = read('app_src/lib/agents/repositoryRunnerConfig.ts')
includes(configuration, "CLAWPILOT_REPOSITORY_RUNNER_ENABLED || '0'", 'disabled-by-default runner')
includes(configuration, 'CLAWPILOT_GITHUB_APP_PRIVATE_KEY_BASE64', 'server-owned GitHub App key')
includes(configuration, 'CLAWPILOT_GITHUB_APP_BOT_USER', 'single GitHub App bot allowlist')
includes(configuration, 'CLAWPILOT_REPOSITORY_RUNNER_REPORT_SECRET', 'signed report secret')
assert.ok(!configuration.includes('agent_chatgpt_credentials'), 'repository configuration must not read user ChatGPT credentials')

const github = read('app_src/lib/githubApp.ts')
includes(github, "permissions: { actions: 'write', contents: 'read', metadata: 'read' }", 'least-privilege installation token')
includes(github, "ref: 'main'", 'fixed default-branch workflow dispatch')
includes(github, 'dispatch_bot_user: input.configuration.appBotUser', 'trusted dispatch bot')
includes(github, 'base_sha: input.baseSha', 'recorded commit dispatch')

const route = read('app_src/app/api/agents/repository-runs/route.ts')
includes(route, 'requireResourceEditor(board)', 'editor authorization')
includes(route, 'isCrmBoardCard(entry)', 'CRM projection exclusion')
includes(route, 'Do not push, merge, deploy, or create a pull request.', 'bounded repository instruction')

const report = read('app_src/app/api/agents/repository-runs/report/route.ts')
includes(report, "createHmac('sha256', configuration.reportSecret)", 'HMAC report authentication')
includes(report, 'MAX_CLOCK_SKEW_MS', 'replay window')
includes(report, "url.hostname === 'github.com'", 'GitHub evidence URL boundary')

const workflow = read('.github/workflows/clawpilot-repository-runner.yml')
includes(workflow, 'uses: openai/codex-action@v1', 'Codex action')
includes(workflow, 'sandbox: workspace-write', 'workspace sandbox')
includes(workflow, 'safety-strategy: drop-sudo', 'privilege reduction')
includes(workflow, 'allow-bot-users: ${{ inputs.dispatch_bot_user }}', 'single trusted bot allowlist')
assert.ok(!workflow.includes('allow-bots: true'), 'patch workflow must not trust every bot')
includes(workflow, 'persist-credentials: false', 'checkout credential removal')
includes(workflow, 'git add --intent-to-add -- .', 'new-file patch capture')
includes(workflow, 'git apply --check', 'clean patch application')
includes(workflow, 'run: npm run check', 'clean validation gate')
includes(workflow, 'X-ClawPilot-Signature: sha256=$SIGNATURE', 'signed callback')
includes(workflow, 'https://aiapp.eigenracing.com/api/agents/repository-runs/report', 'production callback allowlist')
includes(workflow, 'https://dev.aiapp.eigenracing.com/api/agents/repository-runs/report', 'development callback allowlist')
assert.ok(!workflow.includes('https://*.eigenracing.com'), 'patch workflow must not accept wildcard callback hosts')
assert.ok(!workflow.includes('contents: write'), 'patch workflow must not receive source write permission')
assert.ok(!workflow.includes('pull-requests: write'), 'patch workflow must not receive pull request permission')
assert.ok(!/\bgit push\b/.test(workflow), 'patch workflow must not push')
assert.ok(!/\bgh pr create\b/.test(workflow), 'patch workflow must not create pull requests')

const persistence = read('app_src/lib/persistence/repositoryRuns.ts')
includes(persistence, "hashtextextended($1, 0)", 'task-level dispatch lock')
includes(persistence, "target_system = 'agent_runtime'", 'ordinary agent overlap guard')
includes(persistence, "status: task.status === 'done' ? 'done' : 'review'", 'review-only task transition')
includes(persistence, "result_type, payload", 'durable execution evidence')

console.log('repository runner contract tests passed')
