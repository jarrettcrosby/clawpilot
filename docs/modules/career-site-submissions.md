---
id: cp-module-career-site-submissions
title: Career-site submissions
summary: Durable private intake, Google Sheet projection, and Google Mail delivery for Jarrett Crosby's career site.
status: active
kind: module-contract
area: integrations
tags: [career-site, forms, postgres, google-sheets, google-mail, outbox, privacy]
app_visible: true
---

# Career-site submissions

## Purpose

Record accepted contact, résumé-request, and explicit vlog-newsletter submissions from Jarrett Crosby's career site before projecting them into a private Google Sheet. This integration is a bounded personal workflow. It does not turn a visitor into a ClawPilot user, CRM lead, sales opportunity, or marketing subscriber beyond the consent they explicitly supplied.

## Authority and authentication

- Railway Postgres is the durable authority for accepted submissions and delivery state.
- The Google Sheet is a private operator-facing projection. It is not a second intake API or an application database.
- `POST /api/career-site/submissions` is server-to-server only. It reuses the existing authenticated short-link service identity and accepts only the `jarrett-career-site` source, Jarrett's owner email, and the exact `Suburbia Sandwich Co` workspace UUID `405bb919-0364-4a88-8a62-b4c9da42cd8f`.
- The caller supplies the same backend-only bearer secret, `x-shortlink-source`, `x-shortlink-owner`, and mandatory `x-shortlink-organization` headers used by the organization-bound short-link client. Browser code must never receive the secret.
- Every request requires a caller-generated UUID `submissionId`. Exact replays return the existing record; reuse with different normalized data fails with `409`.
- `CAREER_SITE_SUBMISSIONS_ENABLED` defaults off. Enabling it requires the exact owner email, private My Drive Sheet ID, a dedicated short-link client with an unreused secret, and the expected tab/header location.

## Accepted forms

- `contact` stores name, email, optional organization, inquiry category, message, and an optional first-party source URL.
- `resume-request` stores name, email, optional organization, optional context, the requested résumé family (`executive`, `servicenow`, or `odyssey`), the two separate networking and role-fit checkboxes, and an optional first-party source URL. This family is distinct from the ATS versus Coffee Between Chapters edition Jarrett chooses during private approval.
- `newsletter` stores only email, explicit newsletter consent, and an optional first-party source URL. Contact and résumé requests never imply newsletter consent.

The source URL must use `https://jarrett.suburbiasandwichco.com`; query parameters and fragments are removed before persistence. The intake rejects unknown fields and never accepts or stores Turnstile tokens, honeypot values, request IPs, cookies, approval tokens, résumé access grants, short-link URLs, or Google credentials. Original application documents and derived branded career documents remain outside this intake and are not changed by form capture.

## Server caller contract

The production ingress is `POST https://aiapp.eigenracing.com/api/career-site/submissions`. Each of the career site's three server routes calls it only after its own body limits, rate limit, honeypot, timing, schema, and anti-automation checks pass. Required headers are:

```http
Authorization: Bearer <jarrett-career-site service secret>
Content-Type: application/json
x-shortlink-source: jarrett-career-site
x-shortlink-owner: jarrett@suburbiasandwichco.com
x-shortlink-organization: 405bb919-0364-4a88-8a62-b4c9da42cd8f
```

The bearer secret stays in the career site's server-only environment and must match the `jarrett-career-site` entry in ClawPilot's `SHORTLINK_SERVICE_CLIENTS_JSON`. The request is at most 16 KiB. The accepted bodies are:

```json
{
  "submissionId": "<caller-generated UUID>",
  "formType": "contact",
  "name": "Avery Recruiter",
  "email": "avery@example.com",
  "organization": "Example Company",
  "interest": "leadership",
  "message": "I would like to discuss a leadership role.",
  "sourceUrl": "https://jarrett.suburbiasandwichco.com/contact"
}
```

`contact.interest` is one of `leadership`, `advisory`, `product`, `media`, or `other`. Optional `organization` and `sourceUrl` should be omitted rather than sent as empty strings.

```json
{
  "submissionId": "<caller-generated UUID>",
  "formType": "resume-request",
  "name": "Morgan Hiring Manager",
  "email": "morgan@example.com",
  "organization": "Example Company",
  "message": "Director role in Fairfield County",
  "networkInterest": true,
  "roleFit": true,
  "resumeVariant": "executive",
  "sourceUrl": "https://jarrett.suburbiasandwichco.com/resume"
}
```

The résumé route maps its local `context` field to `message` and local `variant` to `resumeVariant`. `resumeVariant` is exactly `executive`, `servicenow`, or `odyssey`. Both `networkInterest` and `roleFit` must be present as explicit booleans; omission is rejected. It must not send `newsletterConsent`.

```json
{
  "submissionId": "<caller-generated UUID>",
  "formType": "newsletter",
  "email": "viewer@example.com",
  "newsletterConsent": true,
  "sourceUrl": "https://jarrett.suburbiasandwichco.com/vlog"
}
```

The newsletter route maps its independently checked local `consent` field to `newsletterConsent: true`. It sends no contact, résumé, networking, or role-fit fields.

A new accepted UUID returns `201`; an exact replay returns `200` and the original record. Both responses contain only the external submission UUID, received timestamp, outbox status, and duplicate flag. Reusing the same source/UUID with different normalized data returns `409`. Invalid data returns `400`, an oversized body returns `413`, invalid service credentials return `401`, an authenticated but wrong owner/source or inactive workspace returns `403`, and disabled/incomplete persistence returns `503`. The caller may retry timeouts and `5xx` responses with the same body and UUID.

## Career Desk Gmail source caller contract

Career Desk reads connected Gmail through `GET|POST https://aiapp.eigenracing.com/api/career-site/sources/gmail`. Both methods require the private `jarrett-career-agents` bearer identity plus the exact owner and organization headers. The public career-site form client is forbidden. The gateway uses each ACTIVE `google-mail` connection's explicit stored binding and makes only Gmail `GET` requests; it never sends, drafts, labels, modifies, or deletes mail and never returns a Maton key, OAuth token, or connection ID.

`GET` returns exactly `{"ok":true,"accounts":[{"accountEmail":"…","status":"ACTIVE"}]}`. Accounts are unique by normalized email, sorted, and capped at 10. A duplicate email bound to multiple active connections is ambiguous and fails closed. `/api/health` exposes only `enabled`, `configured`, `ready`, and `activeAccountCount`, never account emails. Readiness also requires a present, non-revoked stored Maton credential with the exact AES-GCM ciphertext, IV, and tag shape; it does not decrypt the key or probe Gmail. A transient registry read leaves the Gmail source not ready and emits a bounded health warning without exposing credential details.

`POST` accepts only `query`, `after`, and `maxMessagesPerAccount`. `query` is an optional sequence of conservative Gmail refinement tokens; `OR` is accepted only as an infix between validated tokens so the Career Desk default remains compatible. Caller grouping, quoting, braces, pipes, boolean `AND`/`AROUND`, dangling or repeated `OR`, and other grammar that could escape the immutable predicate are rejected. `after` is an optional RFC 3339 timestamp, and the per-account maximum defaults to 10 and is an integer from 1 through 25. Every provider list query always includes ClawPilot's immutable high-signal recruiter, application, interview, and assessment predicate and excludes Gmail Spam, Trash, Sent, and Drafts. Discovery-only job alerts are not query seeds and are rejected again by the deterministic local classifier. `after` and the safely grouped caller refinement are additional requirements; an empty or adversarial request cannot list arbitrary newest personal mail.

The successful response is exactly `{"ok":true,"messages":[…]}` with at most 50 messages total and at most 4 MiB of serialized UTF-8 JSON. Each message contains only `accountEmail`, `externalMessageId`, nullable `externalThreadId`, `receivedAt`, `from`, `subject`, `snippet`, `bodyText`, and `urls`. Sender is validated and capped at 320 characters, snippet at 2,000 characters, body text at 20,000, and public HTTPS URLs at 20 and 2,048 normalized characters each; URL credentials, IP literals, and local/reserved hostnames are rejected. Every provider JSON response is streamed under a hard 8 MiB limit even when `Content-Length` is absent. Messages deleted between list/get, message-local provider rejections (`400`, `404`, `410`, or `422`), malformed full-message payloads, messages without a validated sender, and attachment-only messages without text are omitted independently. Credential, authorization, rate-limit, server, list, and transport failures remain terminal. IDs and validated page tokens are deduplicated per account. Provider listing uses at most four 25-ID pages per account, full-message filtering reads at most 200 round-robin candidates total in batches of 10, and eligible messages backfill the requested per-account maximum without exceeding the 50-message response ceiling. When otherwise-qualified inbound mail needs reply evidence, the source requests only minimal message ID, thread ID, and label metadata and caches that check per bound connection and thread; Sent content is never returned, and directly listed Sent or Draft messages remain excluded. All provider reads retain the explicit owner/account connection binding and share a global concurrency limit of five. A terminal provider failure aborts every sibling read before returning an error.

The producer cancels all provider reads when the caller disconnects and enforces an 85-second internal deadline. The route reserves 120 seconds so the producer can return its bounded error envelope. Callers must allow at least 120 seconds and must validate the exact response bounds before persisting any content.

## Transactional mail caller contract

The career site queues transactional mail through `POST https://aiapp.eigenracing.com/api/career-site/mail`; it does not call a separate email vendor. This endpoint uses the same isolated service identity and active-workspace checks as submission intake. Required headers are:

```http
Authorization: Bearer <jarrett-career-site service secret>
Content-Type: application/json
Idempotency-Key: <message prefix>/<submission or request UUID>
x-shortlink-source: jarrett-career-site
x-shortlink-owner: jarrett@suburbiasandwichco.com
x-shortlink-organization: 405bb919-0364-4a88-8a62-b4c9da42cd8f
```

The body has exactly `messageType`, `idempotencyKey`, and `data`. The header and body idempotency keys must match. Accepted types and exact key prefixes are:

- `contact-notification` with `contact/<submission UUID>` and data fields `submissionId`, `name`, `email`, optional `organization`, `interest`, and `message`;
- `newsletter-request` with `newsletter/<submission UUID>` and data fields `submissionId` and `email`;
- `resume-approval-request` with `resume-request/<request UUID>` and data fields `requestId`, `name`, `email`, optional `organization`, optional `context`, explicit `networkInterest` and `roleFit` booleans, `variant`, and `approvalUrl`;
- `approved-resume-link` with `resume-approved/<request UUID>` and data fields `requestId`, `name`, `email`, `shortUrl`, `variant`, `documentStyle`, `accessMode`, and `expiresAt`.

The service rejects unknown fields. Approval URLs must use one exact HTTPS origin listed in `CAREER_SITE_MAIL_APPROVAL_ORIGINS_JSON`, must target `/resume/approve`, and may contain only its capability token. The approval URL and encrypted `jca1` token are each bounded at 12,000 characters; a maximum valid Unicode résumé-request fixture is regression-tested below the shared 16 KiB request ceiling. Wildcards are forbidden; the production origin is mandatory and each approved Vercel preview hostname is listed separately. Secure résumé links use the exact configured `SHORTLINK_PUBLIC_ORIGIN` (currently `https://eigenracing.com`) and the path is cryptographically bound to the request UUID as `jc-${sha256(requestId).slice(0,16)}`. The site cannot supply From, Reply-To, or the internal notification recipient.

A new message returns `202` with `{"ok":true,"delivery":{"idempotencyKey":"…","status":"queued","duplicate":false}}`. An exact replay returns `200`, `duplicate: true`, and `status: "sent"` only when durable delivery already succeeded; otherwise status remains `queued`. If all bounded delivery attempts are exhausted, exact replay returns `503` with `code: "CAREER_SITE_MAIL_DEAD"`, `duplicate: true`, and `delivery.status: "dead"`; public replay never resets attempts. Reusing a key for different normalized data returns `409`. The caller retries a timeout or `5xx` once with the identical body, header, and key, and never retries a `4xx` response.

## Durable delivery

Migration `0329_career_site_submissions.sql` creates:

- `career_site_submissions`, scoped by the authenticated ClawPilot owner and workspace membership;
- `career_site_submission_outbox`, with one delivery item per submission, scoped by the configured source and owner before claim, leased one item at a time with `FOR UPDATE SKIP LOCKED`, bounded retries, and dead-letter state.

The application commits the submission and outbox row in one Postgres transaction before returning `201`. The Railway poller calls `POST /api/career-site/submissions/outbox/process` with `PIPELINE_OUTBOX_WORKER_SECRET`. The worker uses ClawPilot's existing encrypted Google Workspace credential through `resolveGoogleWorkspacePrivateFileRuntime`; the career site does not need a Google service-account JSON. This private-file runtime requires the verified API key and service-account credential but deliberately does not require or inherit a selected Shared Drive, because the tracker is a private My Drive file shared directly with the service account.

Before reading or writing PII, the worker uses the Drive API to verify that the target is Jarrett's untrashed My Drive spreadsheet, Jarrett is its sole owner, the configured ClawPilot service account is its only writer, editors cannot reshare it, and there are no public, domain, group, pending-owner, other-user, `publishedReader`, or `view=published` permissions. Both permission reads request `includePermissionsForView=published`, so a Sheet published to the web fails closed. It then verifies the exact tab and header row, creating the header only when that row is empty. The permission boundary is checked again immediately before each PII write.

Sheet processing is serialized across replicas with a transaction-scoped Postgres advisory lock. The worker claims exactly one source/owner/organization-scoped item and renews its 15-minute lease immediately before the external write. On retry after an ambiguous write or crash, it requires the submission UUID to appear exactly once and rereads the full RAW A:S row; every value must match the canonical durable projection before delivery can be acknowledged. A partial, duplicate, manual, or mismatched row fails closed. A new submission is written with an idempotent, exact-row Sheets `PUT` and `valueInputOption=RAW`; it never uses the non-idempotent append/insert API. This prevents visitor text beginning with `=`, `+`, `-`, or `@` from becoming a formula and lets an ambiguous response resolve safely on retry. Every write rechecks the next exact row and enforces the 50,000-data-row maximum, so concurrent workers cannot exceed capacity.

Migration `0330_career_site_mail_outbox.sql` adds the source/owner/organization-scoped transactional-mail outbox. Enqueue and idempotency conflict detection occur in Postgres before `202` is returned. Message payloads—including approval capability tokens—are AES-256-GCM encrypted at rest with domain-separated keys from the existing integration-evidence key ring; the stored idempotency fingerprint is keyed. Successful delivery scrubs the encrypted payload immediately. Terminal encrypted payloads are retained for at most 30 days for bounded operator recovery and then scrubbed. The worker records a durable draft-creation intent, searches Gmail drafts by deterministic RFC Message-ID before creation and after an ambiguous create response, and rejects multiple matches. Once creation may have occurred, retries only recover that draft and never create another PII-bearing draft. The existing Railway poller processes one mail item per cycle alongside Sheet projection, with a lease, bounded exponential retries, a dead-letter state, a separate heartbeat, key-retention readiness, and migration/checksum and queue health.

Mail delivery reuses `MATON_API_KEY` and `MATON_GMAIL_CONNECTION_ID`. It does not modify or fall back from the global `CLAWPILOT_MAIL_FROM` sender. Before processing, the worker calls Gmail's `settings/sendAs` API for `info@suburbiasandwichco.com` and requires both the exact alias and `verificationStatus: accepted`.

For retry-safe delivery, the worker assigns one deterministic RFC Message-ID per idempotency key, creates and durably records a Gmail draft, and sends that exact draft. A retry first searches Sent mail for the RFC Message-ID. If the prior send consumed the draft but its response was lost, the worker recovers the sent message instead of creating or sending a second message. An unrecorded draft can be orphaned by a crash before its ID is committed, but it is never sent; only the durably recorded draft is eligible for delivery.

Internal notifications go to `JarrettCrosby@gmail.com`. Requester-facing mail comes from `Jarrett Crosby <info@suburbiasandwichco.com>`, replies to `JarrettCrosby@gmail.com`, calls the URL a secure résumé link, and says only that the requested résumé is ready. It does not expose backend branding or imply that the requester was screened. Newsletter language explicitly preserves separate consent and states that automatic enrollment did not occur.

## Career Desk LinkedIn browser connector

Career Desk uses a separate, owner-scoped LinkedIn browser connection for interactive job reads. It is not LinkedIn OAuth and it never accepts, stores, proxies, or logs a LinkedIn password, MFA code, TOTP seed, recovery code, or challenge answer. Jarrett enters login and checkpoint values directly into the worker's isolated live browser. Posts, comments, messages, applications, and every other external LinkedIn write are outside this connector.

The private `jarrett-career-agents` service identity calls these control-plane routes:

- `GET|DELETE /api/career-site/sources/linkedin` reads safe status or disconnects and cryptographically erases the persisted browser session.
- `POST /api/career-site/sources/linkedin/connect` accepts only a request UUID and `https://jarrett.suburbiasandwichco.com/career/linkedin/return?attemptId=<same UUID>&destination=<overview|agents|settings>`. It returns a short-lived authentication attempt. The initial response alone contains `${CAREER_LINKEDIN_BROWSER_PUBLIC_URL}/live#token=<random preimage>`; the fragment is not sent in an HTTP request. Only its SHA-256 digest is stored, and idempotent replays return `authUrl: null`.
- `GET|DELETE /api/career-site/sources/linkedin/auth-attempt?attemptId=<UUID>` polls or cancels that owner-scoped attempt.
- `POST /api/career-site/sources/linkedin/scan` queues one idempotent, read-only job scan with at most 50 results. A connection has at most one queued, claimed, or authentication-waiting scan. `GET .../scan?scanId=<UUID>` polls the exact run and returns results only after success.

Connection state is one of `disconnected`, `authenticating`, `connected`, `reauth_required`, `restricted`, or `error`. A restriction is explicit and terminal for the run; the worker must not evade it. Scans created without a usable session remain `awaiting_auth`. Successful authentication moves only that connection's waiting scans back to `queued`, preserving their exact IDs and filters.

Migration `0339_career_site_linkedin_connector.sql` stores connection metadata, authentication attempts, scan runs, replay nonces, and the browser session. Browser state is AES-256-GCM encrypted with identity-bound associated data containing the source, owner, organization, and session generation. A dedicated versioned key ring and a separate keyed fingerprint provide rotation and blast-radius isolation. The browser worker receives only a lease-bound, transiently encrypted session envelope and a derived one-run data key; the database never stores that transient key. A claim exposes the renewable five-minute fencing deadline as `expiresAt` and, for authentication commands only, the separate 15-minute user window as `authExpiresAt`. Every flat claim also includes `authTokenAdoptionRequired`; it is false for scans and ordinary authentication claims. Thirty-second `awaiting_auth` reports renew the lease without extending that user window. Expired `claimed` and `awaiting_user` leases are recoverable after a worker crash. The raw live token remains one-time: after the worker locally matches its SHA-256 digest, it reports `evidence.event=live_token_redeemed`; ClawPilot atomically records the redeeming lease digest and worker before the worker may issue its own signed live-session cookie. If that exact current lease and worker repeat the report after losing the response, ClawPilot acknowledges it without a second audit event. If ClawPilot committed redemption but the worker crashed before issuing its cookie, the recovered claim alone sets `authTokenAdoptionRequired: true`; the new current lease must repeat the redemption handshake, which preserves the original redemption time, rebinds the fence, and emits one distinct adoption audit. The expired old lease, an unclaimed worker, a first-attempt mismatched fence, and terminal attempts remain rejected.

Every accepted worker report also writes one durable receipt containing only SHA-256 digests of the exact serialized report body and lease token, the bounded worker ID, report status, and receipt time. A retry with the same body bytes, lease, worker, and status is acknowledged without repeating audit, session-generation, scan-result, or connection-state side effects. An exact active heartbeat retry renews only its current fenced lease. An exact retry after a scan moved to `awaiting_auth`, or after authentication or scan work completed, returns the already stored typed result even though the completing lock was cleared. A changed body, different lease or worker, superseded claim, expired heartbeat lease, cancelled work, or other missing receipt returns `409`. New claims and recovery, cancellation, and authentication-resume transitions clear the prior receipt before work can continue. Worker retries use a fresh HMAC timestamp and nonce with the identical serialized body; timeouts, malformed responses, `408`, `425`, `429`, and `5xx` remain ambiguous and retryable, while every other `4xx` is authoritative.

The worker polls only these unified routes:

- `POST /api/internal/career-site/linkedin/worker/claim`
- `POST /api/internal/career-site/linkedin/worker/report`

Both require `Authorization: Bearer <CAREER_LINKEDIN_BROWSER_WORKER_TOKEN>` plus a distinct HMAC secret. Required signature headers are `x-clawpilot-linkedin-worker-id`, `x-clawpilot-linkedin-timestamp`, `x-clawpilot-linkedin-nonce`, and `x-clawpilot-linkedin-signature`. The signature is lowercase hexadecimal HMAC-SHA256 over these exact newline-delimited UTF-8 bytes:

```text
clawpilot-linkedin-worker-v1
<UPPERCASE HTTP METHOD>
<exact pathname>
<10-digit Unix timestamp seconds>
<lowercase UUID nonce>
<lowercase SHA-256 hex of exact request-body bytes>
```

ClawPilot allows at most 300 seconds of clock skew and records each valid worker-ID/nonce pair before executing the request. A retry therefore uses a fresh nonce and signature while retaining the same durable request ID or current lease ID/token. The bearer token and HMAC secret must be distinct from each other and every other service credential. Request URLs, live token fragments, session envelopes, and session data keys must not be logged.

Required runtime variables are `CAREER_SITE_LINKEDIN_ENABLED`, `CAREER_LINKEDIN_BROWSER_PUBLIC_URL`, `CAREER_LINKEDIN_BROWSER_WORKER_TOKEN`, `CAREER_LINKEDIN_BROWSER_WORKER_HMAC_SECRET`, `CAREER_LINKEDIN_SESSION_ACTIVE_KEY_ID`, `CAREER_LINKEDIN_SESSION_ENCRYPTION_KEYS`, and `CAREER_LINKEDIN_SESSION_FINGERPRINT_KEY`. The two session-key values use base64-encoded, independently generated 32-byte keys. Keep the feature off until migration `0339`, the browser service, and all keys are present.

`/api/health` exposes only non-secret LinkedIn readiness. `workerConnected` is true when ClawPilot recorded an authenticated, replay-protected worker request within the last 30 seconds, and `lastWorkerSeenAt` is that server-side observation time. LinkedIn `ready` requires configuration, session keys, schema, and this fresh worker signal. A transient missing worker signal does not by itself make the global health endpoint fail, which avoids a blue-green rollout deadlock; production verification checks the LinkedIn readiness block after cutover.

## Private Sheet contract

The private tracker uses tab `Submissions`, headers in row 4, and data beginning in row 5. The 19 columns are, in this exact order:

1. Submission ID
2. Submitted At (UTC)
3. Submission Type
4. Full Name
5. Email
6. Organization
7. Resume Variant
8. Network Interest
9. Role Fit
10. Message / Interest
11. Marketing Consent
12. Status
13. Approval Mode
14. Resume Edition
15. Shortlink Status
16. Source URL
17. ClawPilot Owner
18. Last Updated At (UTC)
19. Internal Notes

The ingress writes `New` to Status. It writes `Pending` to Shortlink Status for résumé requests and `Not applicable` for contact/newsletter submissions. Approval Mode, Resume Edition, and Internal Notes remain blank for Jarrett's private workflow. It records the authenticated ClawPilot owner, never a caller-supplied owner, and initializes Last Updated At to the submitted timestamp.

`Shortlink Status` is lifecycle text only. Do not add approval tokens, résumé URLs, ClawPilot short links, or access-grant data to this Sheet. The tracker must stay in Jarrett's private My Drive. Jarrett remains its only owner, grants the configured ClawPilot service account writer access, disables the editor setting that allows resharing, and adds no other user, group, domain, or `anyone` permissions. A Shared Drive target fails closed because its broader membership cannot satisfy this personal PII boundary.
Do not use **Publish to web**. Published-view permissions are included in both the initial permission check and the immediate pre-write recheck, and any published view fails closed.

## Runtime configuration

Set these Railway variables before enabling intake:

- `CAREER_SITE_SUBMISSIONS_ENABLED=1`
- `CAREER_SITE_SUBMISSIONS_OWNER_EMAIL=jarrett@suburbiasandwichco.com`
- `CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID=405bb919-0364-4a88-8a62-b4c9da42cd8f`
- `CAREER_SITE_SUBMISSIONS_SHEET_ID=<private spreadsheet ID>`
- `CAREER_SITE_SUBMISSIONS_SHEET_TAB=Submissions`
- `CAREER_SITE_SUBMISSIONS_SHEET_HEADER_ROW=4`
- optional `CAREER_SITE_SUBMISSIONS_POLL_MS=10000`
- `CAREER_SITE_MAIL_FROM=info@suburbiasandwichco.com`
- `CAREER_SITE_MAIL_FROM_NAME=Jarrett Crosby`
- `CAREER_SITE_MAIL_REPLY_TO=JarrettCrosby@gmail.com`
- `CAREER_SITE_MAIL_APPROVAL_TO=JarrettCrosby@gmail.com`
- `CAREER_SITE_MAIL_APPROVAL_ORIGINS_JSON=["https://jarrett.suburbiasandwichco.com","<exact current Vercel preview origin>"]`

The existing `SHORTLINK_SERVICE_CLIENTS_JSON` must contain a dedicated entry like this (generate a fresh secret; do not reuse another client, the legacy short-link secret, or the outbox-worker secret):

```json
{"sourceApp":"jarrett-career-site","secret":"<unique 32+ character server-only secret>","ownerDomain":"suburbiasandwichco.com","ownerEmail":"jarrett@suburbiasandwichco.com","organizationId":"405bb919-0364-4a88-8a62-b4c9da42cd8f"}
```

The Google Workspace integration in **Settings > Integrations > Google Workspace** must report a verified API key and service account. The selected Shared Drive may remain configured for other ClawPilot features, but the career tracker itself must satisfy the private My Drive boundary above. Do not copy the stored service-account JSON into Vercel or source control. The existing Maton Google Mail connection must be the Suburbia mailbox that owns the accepted `info@suburbiasandwichco.com` send-as alias.

## Operational checks

1. Keep the feature disabled while the migration and private Sheet are prepared. Run `npm run career-site:migrations:verify -- --pre-apply`, which requires both ledger rows and all three tables to be absent; then run `npm run db:migrate` and `npm run career-site:migrations:verify -- --post-apply` to verify exact checksums and the full column/constraint/index catalog. PostgreSQL 16 and 18 have separately frozen catalog digests because their catalog rendering differs; an unverified major version fails closed. The focused migration-verifier test rebuilds the same schema on both supported majors.
2. Verify the Google Workspace integration, share only the Sheet with the displayed service-account email as writer, and disable editor resharing.
3. Verify the `info@suburbiasandwichco.com` alias with Gmail `settings/sendAs`, configure the four career mail values, then enable intake and deploy through the normal `dev` to `main` release path.
4. Submit one contact test with a unique UUID and confirm Postgres returns `201` without returning PII.
5. Confirm the outbox worker appends one row, then replay the same UUID and verify no second row appears.
6. Queue each of the four mail types, replay each exact key, and verify only one Gmail Sent message exists for each deterministic RFC Message-ID.
7. Verify `/api/health` and `/api/persistence/status` report both exact migrations/checksums, encryption-key retention, queue counts, heartbeat freshness, organization scope drift, stale leases, and dead rows without PII. Ordinary bounded retry rows report `degraded` details while readiness remains HTTP 2xx; missing configuration/migrations/worker, stale leases, scope drift, missing encryption keys, or terminal dead rows remain unhealthy and return non-success.
8. Terminal mail and Sheet-projection rows may be requeued only from a same-origin, non-impersonated Jarrett owner/admin browser session through `/api/career-site/mail/requeue` or `/api/career-site/submissions/requeue`. Each requires the operator's observed `expectedGeneration` plus a 10-500 character reason, accepts only dead rows in the exact workspace, records an audit event, preserves any known mail draft and deterministic RFC Message-ID, and caps recovery at three generations. A response-loss replay with the old generation fails closed instead of consuming another recovery. When Gmail creation was ambiguous and no draft ID was ever recovered, an authorized new generation clears only the draft-creation reservation; the next claim searches Gmail again before its single newly authorized create attempt. Public form callers cannot invoke either recovery route.
