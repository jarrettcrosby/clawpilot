#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const migration = read('db/migrations/0040_browser_sessions_and_impersonation.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS app_sessions',
  'token_hash text NOT NULL UNIQUE',
  'authenticated_user_email text NOT NULL REFERENCES app_users',
  'effective_user_email text NOT NULL REFERENCES app_users',
  'idle_expires_at timestamptz NOT NULL',
  'absolute_expires_at timestamptz NOT NULL',
  'revoked_at timestamptz',
  'impersonation_expires_at timestamptz',
  'app_sessions_impersonation_state',
]) assert.ok(migration.includes(fragment), `browser-session migration missing ${fragment}`)

const sessions = read('app_src/lib/authSessions.ts')
for (const fragment of [
  "crypto.randomBytes(32).toString('base64url')",
  'clawpilot-browser-session:v1',
  'token_hash',
  'last_user_activity_at',
  'absolute_timeout',
  'idle_timeout',
  'RECENT_AUTH_SECONDS',
  'IMPERSONATION_TTL_SECONDS',
  "eventType: 'auth.impersonation.started'",
  "eventType: 'auth.impersonation.ended'",
  'effective_user_email = authenticated_user_email',
]) assert.ok(sessions.includes(fragment), `session adapter missing ${fragment}`)
assert.ok(!/^\s*token\s+text\b/m.test(migration), 'raw browser tokens must never be persisted')
const insertedSessionColumns = sessions.match(/INSERT INTO app_sessions\s*\(([^)]*)\)/m)?.[1] || ''
assert.ok(insertedSessionColumns.includes('token_hash'), 'session inserts must persist a token hash')
assert.ok(!/(^|,)\s*token\s*(,|$)/m.test(insertedSessionColumns), 'session inserts must never persist a raw token')

const auth = read('app_src/lib/auth.ts')
assert.ok(auth.includes("'__Host-clawpilot_session'"), 'production session cookie must use __Host prefix')
assert.ok(auth.includes('LEGACY_COOKIE_NAME'), 'legacy cookies must remain readable during rollout')

const attribution = read('app_src/lib/authAttribution.ts')
assert.ok(attribution.includes("createHmac('sha256'"), 'request attribution must be signed')
assert.ok(attribution.includes('timingSafeEqual'), 'request attribution proof must use constant-time verification')

const writer = read('app_src/lib/auditWriter.ts')
for (const fragment of ['verifyAuthAttributionHeaders', 'authenticatedUser', 'effectiveUser', 'impersonated: true']) {
  assert.ok(writer.includes(fragment), `audit impersonation attribution missing ${fragment}`)
}

const proxy = read('app_src/proxy.ts')
for (const fragment of [
  'resolveRequestSession',
  'createAuthAttributionHeaders',
  'sensitiveMutationDuringImpersonation',
  'authorizedWorkerRequest',
]) assert.ok(proxy.includes(fragment), `auth proxy missing ${fragment}`)

const worker = read('app_src/lib/agentDispatchWorker.ts')
assert.ok(worker.includes("'X-ClawPilot-Operator': input.item.operatorId"))
assert.ok(worker.includes("'X-ClawPilot-Board-Id': input.item.boardId"))
assert.ok(!worker.includes('Cookie:'), 'worker cannot authenticate with a browser cookie')
const tasksRoute = read('app_src/app/api/tasks/route.ts')
assert.ok(tasksRoute.includes("throw new Error('Worker board claim mismatch')"), 'worker requests must not override their board claim')

const settings = read('app_src/components/settings/UserAccessDialog.tsx')
assert.ok(settings.includes('SessionSecurityPanel'))
assert.ok(settings.includes('label="Security"'))
const securityPanel = read('app_src/components/settings/SessionSecurityPanel.tsx')
for (const fragment of ['Browser sessions', 'Sign out others', 'Root support mode', 'View as user']) {
  assert.ok(securityPanel.includes(fragment), `security UI missing ${fragment}`)
}
const shell = read('app_src/app/HomeClient.tsx')
assert.ok(shell.includes('<SessionGuard />'))
assert.ok(shell.includes('<ImpersonationBanner />'))

console.log('PASS test-browser-session-security')
