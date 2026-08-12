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
  'getGoogleUserAuthState',
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
  'linkingAvailable: client.configured',
  "membership.status = 'active'",
  'Idempotency-Key was already used for a different Google security command',
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
const userLinking = persistence.slice(
  persistence.indexOf('export async function linkGoogleIdentity'),
  persistence.indexOf('export async function resolveLinkedGoogleIdentity'),
)
assert.ok(
  !userLinking.includes('app_organization_auth_policies'),
  'Per-user Google linking must not depend on a legacy organization policy row',
)
assert.match(
  userLinking,
  /JOIN app_users app_user ON app_user\.email = membership\.user_email[\s\S]{0,180}?membership\.organization_id = \$1::uuid[\s\S]{0,180}?membership\.user_email = \$2[\s\S]{0,120}?membership\.status = 'active'[\s\S]{0,100}?app_user\.status = 'active'[\s\S]{0,100}?FOR SHARE OF membership, app_user/,
  'Google linking must transactionally retain the active user and direct active membership boundary',
)
const linkedLogin = persistence.slice(persistence.indexOf('export async function resolveLinkedGoogleIdentity'))
assert.ok(
  !linkedLogin.includes('app_organization_auth_policies'),
  'Google login must not depend on a legacy organization policy row',
)
for (const fragment of [
  "identity.provider = 'google'",
  'identity.provider_subject = $1',
  'identity.user_email = $2',
  'identity.verified_email = $2',
  "membership.status = 'active'",
  "linked.user_status !== 'active'",
  'This Google account has no active ClawPilot organization membership',
  'requireWorkspaceAppUser(linked.user_email, linked.organization_id)',
]) {
  assert.ok(linkedLogin.includes(fragment), `User-scoped Google login missing ${fragment}`)
}

const policyRoute = read('app_src/app/api/auth/google/policy/route.ts')
for (const fragment of [
  'requireRequestSession',
  'requireWorkspaceAppUser',
  'session.impersonating',
  'getGoogleUserAuthState',
  'GOOGLE_SSO_USER_SCOPED',
  'configured separately by each ClawPilot user',
]) {
  assert.ok(policyRoute.includes(fragment), `Google user-link state route missing ${fragment}`)
}
assert.ok(!policyRoute.includes('updateGoogleOrganizationPolicy'), 'The user-link UI API must not mutate legacy organization policy')

const linkRoute = read('app_src/app/api/auth/google/link/route.ts')
for (const fragment of [
  'requireRequestSession',
  'session.authenticatedUser !== session.effectiveUser',
  'SESSION_POLICY.recentAuthSeconds',
  'verifyGoogleIdentityToken(body.idToken)',
  '`expectedPolicyRowVersion` is accepted and ignored',
  "req.headers.get('idempotency-key')",
  'linkGoogleIdentity',
]) {
  assert.ok(linkRoute.includes(fragment), `Authenticated Google link route missing ${fragment}`)
}

const settings = read('app_src/components/settings/GoogleAuthSettingsPanel.tsx')
for (const fragment of [
  'Magic codes remain available.',
  'Google linking belongs only to this user.',
  'every direct active organization membership',
  'It does not enable Google for any other user.',
  'A different Google email will be rejected',
  'https://accounts.google.com/gsi/client',
  "'/api/auth/google/policy'",
  "'/api/auth/google/link'",
  "'Idempotency-Key'",
  'Retry Google link',
  'existing?.remove()',
]) {
  assert.ok(settings.includes(fragment), `Google security settings UI missing ${fragment}`)
}
assert.ok(!settings.includes("method: 'PATCH'"), 'Per-user Google settings must not expose a legacy organization policy mutation')
assert.ok(!settings.includes('expectedPolicyRowVersion'), 'Per-user Google linking must not be organization-version fenced')
const sessionSettings = read('app_src/components/settings/SessionSecurityPanel.tsx')
assert.ok(sessionSettings.includes('GoogleAuthSettingsPanel'), 'Security settings must expose Google account linking')

const nativeAdapter = read('clients/apple/Sources/ClawPilotPickingApple/AppleAdapters.swift')
for (const fragment of [
  'fetchGoogleAuthState()',
  'endpoint("/api/auth/google/policy")',
  'linkGoogleIdentityToken(',
  'endpoint("/api/auth/google/link")',
  'canLinkCurrentUser',
  'forHTTPHeaderField: "Idempotency-Key"',
  'if let envelope, let code = envelope.code',
]) {
  assert.ok(nativeAdapter.includes(fragment), `Native Google account-link API missing ${fragment}`)
}
assert.ok(!nativeAdapter.includes('expectedPolicyRowVersion'), 'Native Google linking must be user-scoped')

const nativeModel = read('clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
for (const fragment of [
  'refreshGoogleAuthState()',
  'linkCurrentGoogleAccount()',
  'GIDSignIn.sharedInstance.signOut()',
  'Other users must link their own account.',
  "across this user's direct organization memberships",
  'where code == "GOOGLE_SSO_LINK_REQUIRED"',
  'idempotencyKey: UUID().uuidString',
]) {
  assert.ok(nativeModel.includes(fragment), `Native per-user Google linking flow missing ${fragment}`)
}
assert.ok(!nativeModel.includes('expectedPolicyRowVersion'), 'Native linking cannot depend on an organization policy version')

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
const workspaceSwitch = sessions.slice(sessions.indexOf('export async function switchBrowserSessionWorkspace'))
assert.ok(!workspaceSwitch.includes('app_organization_auth_policies'), 'Workspace switching must ignore inert legacy Google organization flags')
assert.ok(!workspaceSwitch.includes('google_sign_in_enabled'), 'Workspace switching must not re-authorize a linked user through target policy')
assert.match(
  workspaceSwitch,
  /membership\.user_email = \$1[\s\S]{0,120}?membership\.organization_id = \$2::uuid[\s\S]{0,120}?membership\.status = 'active'/,
  'Linked users may switch only into an exact direct active membership',
)
assert.ok(workspaceSwitch.includes("if (!membership.rows[0]) throw new Error('Business access is not available')"), 'Missing memberships must remain blocked')
const workspaceRoute = read('app_src/app/api/auth/workspace/route.ts')
assert.ok(
  workspaceRoute.includes("session.authMethod === 'google_sso'"),
  'A Google-authenticated session must not create a new business membership',
)
assert.ok(
  workspaceRoute.includes('Sign in with a magic code before creating a new business membership'),
  'The create-root fence must use user-scoped wording',
)

console.log('PASS test-google-sso')
