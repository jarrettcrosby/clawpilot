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
  'resolveLinkedGoogleIdentity(identity)',
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
assert.ok(
  !route.includes('requireWorkspaceAppUser(identity.email)'),
  'Google login must not resolve authorization from an unlinked email alone',
)

const linkingMigration = read('db/migrations/0265_google_identity_linking.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS app_organization_auth_policies',
  'google_sign_in_enabled boolean NOT NULL DEFAULT false',
  'row_version bigint NOT NULL DEFAULT 0',
  'CREATE TABLE IF NOT EXISTS app_user_external_identities',
  "provider text NOT NULL CHECK (provider = 'google')",
  'PRIMARY KEY (provider, provider_subject)',
  'UNIQUE (provider, user_email)',
  'verified_email = user_email',
  'CREATE TABLE IF NOT EXISTS app_auth_mutation_receipts',
  "command_type IN ('google_policy_update', 'google_identity_link')",
  'PRIMARY KEY (organization_id, actor_email, idempotency_key)',
  "request_hash ~ '^[0-9a-f]{64}$'",
  'CREATE OR REPLACE FUNCTION reject_app_auth_immutable_mutation()',
  'BEFORE UPDATE OR DELETE ON app_user_external_identities',
  'BEFORE UPDATE OR DELETE ON app_auth_mutation_receipts',
]) {
  assert.ok(linkingMigration.includes(fragment), `Google identity-linking migration missing ${fragment}`)
}
assert.ok(
  !/app_user_external_identities[\s\S]{0,500}user_email text NOT NULL REFERENCES app_users\(email\) ON DELETE CASCADE/.test(linkingMigration),
  'Immutable Google identity rows must not disappear through a user-delete cascade',
)
assert.ok(
  !/app_auth_mutation_receipts[\s\S]{0,500}ON DELETE CASCADE/.test(linkingMigration),
  'Immutable auth receipts must not disappear through an authority-delete cascade',
)

const persistence = read('app_src/lib/persistence/googleIdentityLinking.ts')
for (const fragment of [
  'getGoogleOrganizationAuthState',
  'updateGoogleOrganizationPolicy',
  'linkGoogleIdentity',
  'resolveLinkedGoogleIdentity',
  'canManageUserAccess(input.actor)',
  'input.identity.email !== actorEmail',
  "identity.provider = 'google'",
  'identity.provider_subject = $1',
  'identity.user_email = $2',
  'identity.verified_email = $2',
  'policy.google_sign_in_enabled = true',
  "membership.status = 'active'",
  'Idempotency-Key was already used for a different Google security command',
  'Google sign-in settings changed. Reload',
  "eventType: 'auth.organization.google_policy.updated'",
  "eventType: 'auth.identity.google.linked'",
]) {
  assert.ok(persistence.includes(fragment), `Google identity persistence missing ${fragment}`)
}
for (const prohibited of [
  'INSERT INTO app_users',
  'INSERT INTO app_user_organization_memberships',
  'UPDATE app_users',
]) {
  assert.ok(!persistence.includes(prohibited), `Google identity linking must not mutate user authority: ${prohibited}`)
}
assert.ok(
  !persistence.includes('idToken'),
  'Google identity persistence must never receive or store the raw Google ID token',
)

const policyRoute = read('app_src/app/api/auth/google/policy/route.ts')
for (const fragment of [
  'requireRequestSession',
  'requireWorkspaceAppUser',
  'session.impersonating',
  'SESSION_POLICY.recentAuthSeconds',
  "req.headers.get('idempotency-key')",
  'expectedRowVersion',
  'updateGoogleOrganizationPolicy',
]) {
  assert.ok(policyRoute.includes(fragment), `Google organization policy route missing ${fragment}`)
}

const linkRoute = read('app_src/app/api/auth/google/link/route.ts')
for (const fragment of [
  'requireRequestSession',
  'session.authenticatedUser !== session.effectiveUser',
  'SESSION_POLICY.recentAuthSeconds',
  'verifyGoogleIdentityToken(body.idToken)',
  'expectedPolicyRowVersion',
  "req.headers.get('idempotency-key')",
  'linkGoogleIdentity',
]) {
  assert.ok(linkRoute.includes(fragment), `Authenticated Google link route missing ${fragment}`)
}

const settings = read('app_src/components/settings/GoogleAuthSettingsPanel.tsx')
for (const fragment of [
  'Magic codes remain available.',
  'OAuth app credentials remain platform managed.',
  'A different Google email will be rejected',
  'https://accounts.google.com/gsi/client',
  "'/api/auth/google/policy'",
  "'/api/auth/google/link'",
  "'Idempotency-Key'",
  'expectedPolicyRowVersion: policy.rowVersion',
  'Retry Google link',
  'existing?.remove()',
]) {
  assert.ok(settings.includes(fragment), `Google security settings UI missing ${fragment}`)
}
const sessionSettings = read('app_src/components/settings/SessionSecurityPanel.tsx')
assert.ok(sessionSettings.includes('GoogleAuthSettingsPanel'), 'Security settings must expose Google account linking')

const nativeAdapter = read('clients/apple/Sources/ClawPilotPickingApple/AppleAdapters.swift')
for (const fragment of [
  'fetchGoogleAuthState()',
  'endpoint("/api/auth/google/policy")',
  'linkGoogleIdentityToken(',
  'endpoint("/api/auth/google/link")',
  'expectedPolicyRowVersion',
  'forHTTPHeaderField: "Idempotency-Key"',
  'if let envelope, let code = envelope.code',
]) {
  assert.ok(nativeAdapter.includes(fragment), `Native Google account-link API missing ${fragment}`)
}

const nativeModel = read('clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
for (const fragment of [
  'refreshGoogleAuthState()',
  'linkCurrentGoogleAccount()',
  'GIDSignIn.sharedInstance.signOut()',
  'expectedPolicyRowVersion: state.rowVersion',
  'Other users must link their own account.',
  'where code == "GOOGLE_SSO_LINK_REQUIRED"',
  'expectedPolicyRowVersion: state.rowVersion',
  'idempotencyKey: UUID().uuidString',
]) {
  assert.ok(nativeModel.includes(fragment), `Native per-user Google linking flow missing ${fragment}`)
}

const nativeShell = read('clients/apple/Apps/iPhone/ClawPilotAppShellView.swift')
for (const fragment of [
  'Text("Link my Google account")',
  'state.identity.linked ? "LINKED" : "NOT LINKED"',
  'model.linkCurrentGoogleAccount()',
]) {
  assert.ok(nativeShell.includes(fragment), `Native signed-in Google link UI missing ${fragment}`)
}

const envExample = read('.env.example')
for (const fragment of [
  'GOOGLE_SSO_SERVER_CLIENT_ID',
  'same public client ID to browser GIS',
  'server-side ID-token',
  'authorized JavaScript origins',
]) {
  assert.ok(envExample.includes(fragment), `Google OAuth runtime configuration missing ${fragment}`)
}
const accessContract = read('docs/modules/application-shell-and-access.md')
for (const fragment of [
  'OAuth 2.0 **Web application** client ID',
  'https://dev.aiapp.eigenracing.com',
  'https://aiapp.eigenracing.com',
  'browser and native ID tokens against it as the server audience',
]) {
  assert.ok(accessContract.includes(fragment), `Google access contract missing ${fragment}`)
}

const migration = read('db/migrations/0257_google_sso_sessions.sql')
assert.ok(migration.includes("'google_sso'"), 'Google SSO session method migration is missing')

const sessions = read('app_src/lib/authSessions.ts')
assert.ok(sessions.includes("'google_sso'"), 'Google SSO must use the shared ClawPilot session authority')
for (const fragment of [
  "input.session.authMethod === 'google_sso'",
  'COALESCE(auth_policy.google_sign_in_enabled, false)',
  'Google sign-in is not enabled for that business',
]) {
  assert.ok(sessions.includes(fragment), `Google-authenticated workspace switch guard missing ${fragment}`)
}
const workspaceRoute = read('app_src/app/api/auth/workspace/route.ts')
assert.ok(
  workspaceRoute.includes("session.authMethod === 'google_sso'"),
  'A Google-authenticated session must not create and enter a default-disabled root business',
)

console.log('PASS test-google-sso')
