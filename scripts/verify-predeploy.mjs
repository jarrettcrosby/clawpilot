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

if (!existsSync(resolve(root, 'vercel.json'))) {
  fail('missing vercel.json')
}

if (!existsSync(resolve(root, 'railway.json'))) {
  fail('missing railway.json')
}

const vercel = readJson('vercel.json')
if (String(vercel.installCommand || '') !== 'npm ci') {
  fail('vercel.json installCommand must be "npm ci"')
}

if (String(vercel.buildCommand || '') !== 'npm run build') {
  fail('vercel.json buildCommand must be "npm run build"')
}

if (String(vercel.outputDirectory || '') !== '.next') {
  fail('vercel.json outputDirectory must be ".next"')
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

if (String(railway?.deploy?.preDeployCommand || '') !== 'npm run db:migrate') {
  fail('railway.json deploy.preDeployCommand must run "npm run db:migrate"')
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
  'scripts/start-railway.sh',
  'scripts/pipeline-outbox-poller.mjs',
  'scripts/smoke-deployed-runtime.mjs',
  'app_src/proxy.ts',
  'app_src/app/api/auth/magic/request/route.ts',
  'app_src/app/api/auth/magic/verify/route.ts',
  'app_src/app/api/agents/auth/route.ts',
  'app_src/app/api/agents/auth/poll/route.ts',
  'app_src/app/api/agents/dispatch/process/route.ts',
  'app_src/lib/agentDispatchWorker.ts',
  'app_src/app/api/users/route.ts',
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
