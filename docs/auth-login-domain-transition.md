# Owner login after a Google Workspace domain rename

ClawPilot uses `app_users.email` as its durable account key. Memberships, audit history, provider connections, browser sessions, and Career Desk service credentials refer to that key. Changing `APP_LOGIN_EMAIL` by itself can create a second owner; it is not an account migration.

`APP_LOGIN_EMAIL_ALIASES` permits up to eight comma-separated exact login addresses for the existing owner. Keep `APP_LOGIN_EMAIL` unchanged. The resolver rejects an alias that already belongs to an independent `app_users` record. It does not match entire domains, strip plus tags, or merge accounts.

Magic codes are sent to the address entered by the user and are digest-bound to that address. Successful verification creates a session for the original account key. Invitation acceptance retains its original exact-recipient boundary. Removing an alias prevents future authentication using that address.

Google login requires the existing linked Google subject, original canonical user key, and enrollment email. An explicitly configured login alias can resolve to that original key after the same Google Workspace account is renamed. An unrelated Google account with the new email cannot use the old account's link. New Google identity enrollment remains exact-email only; changing to a different Google account requires a separate reviewed account-link procedure.

## Observed production identity on September 7, 2026

- Original owner: `jarrett@suburbiasandwichco.com`, user reference `gu5591947`, contact reference `gc3327424`; four memberships and the existing Google link must be preserved.
- `jarrett@bposupplychain.com` does not currently have a ClawPilot user row.
- `jarrettcrosby@gmail.com` is a separate active member. Do not silently map it to the owner.
- Career Desk service ownership, Gmail/Maton connections, encrypted state, and submission ownership still use the original owner key.

Once the user's exact new login email is confirmed and this code is deployed, the scoped configuration change is `APP_LOGIN_EMAIL_ALIASES=jarrett@bposupplychain.com`. Do not change the original account, service principal, memberships, provider connection IDs, or encrypted-data ownership. Verify Google authentication using the renamed original Workspace account and magic-code authentication using the new address, then verify the same user references and memberships. No production configuration or user records were changed while preparing this implementation.

## Career Desk sign-in mail bridge

`POST /api/career-site/auth/send-code` accepts exactly `{ "email": "…", "code": "123456" }` through the existing isolated `jarrett-career-agents` service client, original owner, and Career Desk organization. The caller owns recipient authorization and durable code issuance, expiry, consumption, and attempt limits. The endpoint validates the private bridge before reading a body, bounds the body to 2 KB, rejects custom content, and sends only the fixed Career Desk sign-in template through the existing authentication mail transport.

The endpoint returns `{ "ok": true }` only after delivery succeeds. It returns generic errors and never includes the code, recipient, provider response, or raw failure detail. A per-process additional limit allows one request per minute and five per fifteen minutes per recipient; this supplements the caller's durable issuance limit. Sign-in messages use the existing authentication-purpose marker so CRM/job inbox ingestion excludes them.

The site should call the bridge once per issued code and fail the issuance on delivery failure. An uncertain send must not be blindly retried; the user can request a fresh code after the resend interval.

## Verification

The auth suite passed, including real PostgreSQL invitation acceptance, owner-alias code issuance/consumption, unchanged membership rows, and rejection of an alias colliding with an independent account. This host's Docker metadata filesystem is read-only, so `CLAWPILOT_AUTH_TEST_POSTGRES_MODE=local npm run test:auth` used a newly initialized temporary local cluster; the cluster was stopped and removed after the test. The default CI mode continues to use disposable Docker PostgreSQL.

Lint passed. Application-source TypeScript checking passed across 758 source roots with zero errors. The repository-wide standalone TypeScript command also includes existing test fixtures and reports their unrelated errors. The normal production build reached webpack but could not complete because the host filesystem returned `ENOSPC` while writing `.next`; a completed build and deployment verification remain required before release.
