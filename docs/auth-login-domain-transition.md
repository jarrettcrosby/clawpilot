---
id: cp-owner-login-domain-transition
title: Owner Login Domain Transition
summary: Preserve canonical owner identity after an email rename and deliver Career Desk sign-in codes through the isolated mail bridge.
status: active
kind: operating-contract
area: access
tags: [clawpilot, authentication, google, career-desk]
app_visible: false
---

# Owner login after a Google Workspace domain rename

ClawPilot uses `app_users.email` as its durable account key. Memberships, audit history, provider connections, browser sessions, and Career Desk service credentials refer to that key. Changing `APP_LOGIN_EMAIL` by itself can create a second owner; it is not an account migration.

`APP_LOGIN_EMAIL_ALIASES` permits up to eight comma-separated exact login addresses for the existing owner. Keep `APP_LOGIN_EMAIL` unchanged. The resolver rejects an alias that already belongs to an independent `app_users` record. It does not match entire domains, strip plus tags, or merge accounts.

Magic codes are sent to the address entered by the user and are digest-bound to that address. Successful verification creates a session for the original account key. Invitation acceptance retains its original exact-recipient boundary. Removing an alias prevents future authentication using that address.

Google login requires the existing linked Google subject, original canonical user key, and enrollment email. An explicitly configured login alias can resolve to that original key after the same Google Workspace account is renamed. An unrelated Google account with the new email cannot use the old account's link. New Google identity enrollment remains exact-email only; changing to a different Google account requires a separate reviewed account-link procedure.

## Operator configuration

Inspect the current owner, linked provider subject, memberships, and any existing account at the proposed new address before configuring an alias. Keep account-specific observations and identifiers in the approved operator runtime record, outside Git.

After confirming the exact new login email, configure an exact alias such as `APP_LOGIN_EMAIL_ALIASES=operator@new-domain.example`. Preserve the original account, service principal, memberships, provider connection IDs, and encrypted-data ownership. Verify Google authentication using the renamed original Workspace account and magic-code authentication using the new address, then verify that the same user references and memberships remain. An independent account must remain separate.

## Career Desk sign-in mail bridge

`POST /api/career-site/auth/send-code` accepts exactly `{ "email": "…", "code": "123456" }` through the existing isolated `jarrett-career-agents` service client, original owner, and Career Desk organization. The caller owns recipient authorization and durable code issuance, expiry, consumption, and attempt limits. The endpoint validates the private bridge before reading a body, bounds the body to 2 KB, rejects custom content, and sends only the fixed Career Desk sign-in template through the existing authentication mail transport.

The endpoint returns `{ "ok": true }` only after delivery succeeds. It returns generic errors and never includes the code, recipient, provider response, or raw failure detail. A per-process additional limit allows one request per minute and five per fifteen minutes per recipient; this supplements the caller's durable issuance limit. Sign-in messages use the existing authentication-purpose marker so CRM/job inbox ingestion excludes them.

The site should call the bridge once per issued code and fail the issuance on delivery failure. An uncertain send must not be blindly retried; the user can request a fresh code after the resend interval.

## Verification

Run `npm run test:auth` for magic-code and Google identity checks, including real PostgreSQL invitation acceptance, owner-alias code issuance/consumption, unchanged membership rows, and rejection of an alias colliding with an independent account. The default mode uses disposable Docker PostgreSQL. If Docker is unavailable and local PostgreSQL tools are installed, `CLAWPILOT_AUTH_TEST_POSTGRES_MODE=local npm run test:auth` initializes a temporary local cluster, then stops and removes only that cluster.

Complete the normal lint, build, tests, documentation, and predeploy gates before release. After deployment, verify version, health, and signed-in identity continuity. Keep current validation results in the release record rather than this contract.
