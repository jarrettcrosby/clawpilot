#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (path) => readFileSync(resolve(path), 'utf8')

const identity = read('app_src/lib/googleSso.ts')
for (const fragment of [
  "from 'google-auth-library'",
  'GOOGLE_SSO_SERVER_CLIENT_ID',
  'verifyIdToken',
  'audience',
  'email_verified !== true',
]) {
  assert.ok(identity.includes(fragment), `Google identity verifier missing ${fragment}`)
}

const route = read('app_src/app/api/auth/google/native/route.ts')
for (const fragment of [
  'verifyGoogleIdentityToken',
  'requireWorkspaceAppUser(identity.email)',
  "authMethod: 'google_sso'",
  'setBrowserSessionCookie',
  "method: 'google_sso'",
]) {
  assert.ok(route.includes(fragment), `Google SSO route missing ${fragment}`)
}
assert.ok(
  !route.includes('ensureOwnerUser'),
  'Google SSO must never auto-create or promote a ClawPilot user',
)

const migration = read('db/migrations/0257_google_sso_sessions.sql')
assert.ok(migration.includes("'google_sso'"), 'Google SSO session method migration is missing')

const sessions = read('app_src/lib/authSessions.ts')
assert.ok(sessions.includes("'google_sso'"), 'Google SSO must use the shared ClawPilot session authority')

console.log('PASS test-google-sso')
