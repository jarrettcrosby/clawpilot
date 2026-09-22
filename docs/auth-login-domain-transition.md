---
id: cp-owner-login-domain-transition
title: Owner Login Domain Transition
summary: Preserve durable user identity across verified login changes, operate safe authentication rollouts, and deliver Career Desk sign-in codes through the isolated mail bridge.
status: active
kind: operating-contract
area: access
tags: [clawpilot, authentication, google, career-desk]
app_visible: false
---

# Owner login after a Google Workspace domain rename

ClawPilot uses `app_users.email` as its durable account key. Memberships, audit history, provider connections, browser sessions, and Career Desk service credentials refer to that key. Changing `APP_LOGIN_EMAIL` by itself can create a second owner; it is not an account migration.

`APP_LOGIN_EMAIL_ALIASES` permits up to eight comma-separated exact login addresses for the existing owner. Keep `APP_LOGIN_EMAIL` unchanged. The resolver rejects an alias that already belongs to an independent `app_users` record. It does not match entire domains, strip plus tags, or merge accounts.

This alias compatibility path applies only while the owner has no verified login override. After a Settings > Profile login-email change is confirmed, only that verified login address resolves to the durable account; the original address and configured aliases stop authenticating. Do not change the durable key or remove the override to restore an old login.

Magic codes are sent to the address entered by the user and are digest-bound to that address. Successful verification creates a session for the original account key. Invitation acceptance retains its original exact-recipient boundary. Removing an alias prevents future authentication using that address.

Google login requires the existing linked Google subject, original canonical user key, and enrollment email. An explicitly configured login alias can resolve to that original key after the same Google Workspace account is renamed. An unrelated Google account with the new email cannot use the old account's link. New Google identity enrollment remains exact-email only; changing to a different Google account requires a separate reviewed account-link procedure.

## Operator configuration

Inspect the current owner, linked provider subject, memberships, and any existing account at the proposed new address before configuring an alias. Keep account-specific observations and identifiers in the approved operator runtime record, outside Git.

After confirming the exact new login email, configure an exact alias such as `APP_LOGIN_EMAIL_ALIASES=operator@new-domain.example`. Preserve the original account, service principal, memberships, provider connection IDs, and encrypted-data ownership. Verify Google authentication using the renamed original Workspace account and magic-code authentication using the new address, then verify that the same user references and memberships remain. An independent account must remain separate.

## Verified login-email changes

Login-email changes are default-off until `CLAWPILOT_LOGIN_EMAIL_CHANGE_ENABLED=1` is explicitly set after the rollout checks below. Missing, `0`, or any other value disables both requesting and confirming a change before any state-writing transaction or email. The API still returns the current sign-in address, and Settings explicitly explains the unavailable state with disabled controls. This gate does not disable ordinary sign-in, existing verified login resolution, Trash/Restore, or organization web settings. Turning it off also blocks confirmation of an already-issued challenge.

When enabled, use Settings > Profile after recent non-impersonated authentication. The user must verify a bounded, expiring code sent to the new inbox. Confirmation stores a verified login override without renaming `app_users.email`, revokes existing sessions and sign-in codes, and requires a fresh sign-in. Google login must be explicitly relinked to the current verified address. Original Google identity rows, subject ownership, and mutation receipts remain immutable; unlinking a current binding never releases its provider subject to another user. Organization access, CRM history, provider credentials, and mail-sender settings remain unchanged.

## Production rollout and rollback boundary

1. Verify a usable production backup and the exact target release. Apply migrations `0369`–`0371` through `npm run db:migrate`; it wraps each migration in one transaction. Migration `0370` locks `app_users` then `app_user_external_identities` in `SHARE ROW EXCLUSIVE` mode before DDL/backfill. Existing reads and user row-share checks remain possible, while identity inserts wait until the ownership seed and insert trigger are committed together. Do not run fragments outside that transaction or edit a migration already recorded in a hosted database.
2. The schema changes are additive and preserve the durable user key, original identity rows, and old short links. This does **not** make mixed-version authentication safe after a login change: pre-`0370` application code ignores login overrides and still trusts original Google identity links and legacy signed sessions.
3. Keep `CLAWPILOT_LOGIN_EMAIL_CHANGE_ENABLED` unset or `0` during deployment. Use a zero-overlap rollout for the singleton app service. Confirm the old deployment is removed and no old app, worker, preview, or replica using the production database can issue/resolve authentication. Vercel SSO protection is not database isolation: an old deployment retaining production database/session credentials remains in scope. Verify the deployed SHA, health, persistence, and fresh signed-in behavior. Only after old runtimes are retired or demonstrably isolated and activation is approved, explicitly set the flag to `1` on the approved current app runtime. If that inventory is incomplete, leave the feature disabled; do not merely rely on the new UI hiding the control.
4. Organization web-domain policy also becomes authoritative only after old application instances are drained. Old code may still generate canonical invitations or legacy-domain short links during overlap. Existing links remain valid; provider OAuth callbacks and general authentication URLs retain the canonical origin.
5. Before any verified login change, an old application binary can be a structural rollback target with the additive schema left intact, provided no new organization-domain enforcement is relied upon. After **any** confirmed login change, do not roll back to code that ignores the override: doing so would reauthorize the old address, original Google link, and potentially legacy sessions. Use a forward fix or a rollback build that preserves the new authentication checks. Do not delete overrides, immutable ownership records, or security receipts, and do not restore a database snapshot just to roll back application code.
6. Confirm the configured owner's separate operator-secret/password recovery path remains available without changing `APP_LOGIN_EMAIL`. It is not an email-authentication fallback and does not justify permitting retired email credentials.

## Career Desk sign-in mail bridge

`POST /api/career-site/auth/send-code` accepts exactly `{ "email": "…", "code": "123456" }` through the existing isolated `jarrett-career-agents` service client, original owner, and Career Desk organization. The caller owns recipient authorization and durable code issuance, expiry, consumption, and attempt limits. The endpoint validates the private bridge before reading a body, bounds the body to 2 KB, rejects custom content, and sends only the fixed Career Desk sign-in template through the existing authentication mail transport.

The endpoint returns `{ "ok": true }` only after delivery succeeds. It returns generic errors and never includes the code, recipient, provider response, or raw failure detail. A per-process additional limit allows one request per minute and five per fifteen minutes per recipient; this supplements the caller's durable issuance limit. Sign-in messages use the existing authentication-purpose marker so CRM/job inbox ingestion excludes them.

The site should call the bridge once per issued code and fail the issuance on delivery failure. An uncertain send must not be blindly retried; the user can request a fresh code after the resend interval.

## Verification

Run `npm run test:auth` for magic-code and Google identity checks, including real PostgreSQL invitation acceptance, owner-alias code issuance/consumption, unchanged membership rows, and rejection of an alias colliding with an independent account. The default mode uses disposable Docker PostgreSQL. If Docker is unavailable and local PostgreSQL tools are installed, `CLAWPILOT_AUTH_TEST_POSTGRES_MODE=local npm run test:auth` initializes a temporary local cluster, then stops and removes only that cluster.

Complete the normal lint, build, tests, documentation, and predeploy gates before release. After deployment, verify version, health, and signed-in identity continuity. Keep current validation results in the release record rather than this contract.
