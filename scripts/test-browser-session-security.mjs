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

const ipMigration = read('db/migrations/0044_browser_session_ip_attribution.sql')
for (const fragment of ['initial_ip_address inet', 'last_ip_address inet', 'hosting edge']) {
  assert.ok(ipMigration.includes(fragment), `browser-session IP migration missing ${fragment}`)
}

const requestIp = read('app_src/lib/requestIpAddress.ts')
for (const fragment of ["from 'node:net'", 'normalizeIpAddress', 'observedRequestIpAddress', 'x-vercel-forwarded-for', 'x-forwarded-for']) {
  assert.ok(requestIp.includes(fragment), `request IP normalization missing ${fragment}`)
}

const sessions = read('app_src/lib/authSessions.ts')
for (const fragment of [
  "crypto.randomBytes(32).toString('base64url')",
  'clawpilot-browser-session:v1',
  'token_hash',
  'last_user_activity_at',
  'host(session.initial_ip_address) AS initial_ip_address',
  'host(session.last_ip_address) AS last_ip_address',
  '$7::inet',
  "$8::integer * interval '1 second'",
  "$9::integer * interval '1 second'",
  'absolute_timeout',
  'idle_timeout',
  'RECENT_AUTH_SECONDS',
  'IMPERSONATION_TTL_SECONDS',
  "$4::integer * interval '1 second'",
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
const authAudit = read('app_src/lib/authAudit.ts')
assert.ok(authAudit.includes('observedRequestIpAddress(req.headers)'), 'auth audit must fingerprint only validated observed addresses')
assert.ok(!authAudit.includes('ipAddress:'), 'general auth audit payload must not persist raw IP addresses')

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
for (const fragment of [
  'Owner access is fixed and always includes every permission.',
  'Your permissions are managed by another organization administrator.',
  'Promote this user to Admin to enable administrative permissions.',
  'An admin cannot grant access they do not hold.',
]) {
  assert.ok(settings.includes(fragment), `permission UI guidance missing ${fragment}`)
}
const securityPanel = read('app_src/components/settings/SessionSecurityPanel.tsx')
for (const fragment of [
  'Browser sessions',
  'Sign out others',
  'Root support mode',
  'View as user',
  'authenticatedUser',
  'effectiveUser',
  'Last observed IP',
  'Sign-in IP',
]) {
  assert.ok(securityPanel.includes(fragment), `security UI missing ${fragment}`)
}
const shell = read('app_src/app/HomeClient.tsx')
assert.ok(shell.includes('<SessionGuard enabled={sessionGuardEnabled} />'))
assert.ok(shell.includes('<ImpersonationBanner />'))
const sessionGuard = read('app_src/components/auth/SessionGuard.tsx')
assert.ok(sessionGuard.includes('if (!enabled) return'), 'local auth-disabled runtime must not redirect through SessionGuard')
const page = read('app_src/app/page.tsx')
assert.ok(page.includes("process.env.APP_AUTH_REQUIRED === '1'"), 'server shell must pass the hosted auth requirement')
assert.ok(page.includes('sessionGuardEnabled={sessionGuardEnabled}'), 'server auth decision must reach the client guard')

console.log('PASS test-browser-session-security')
