---
id: cp-module-career-site-submissions
title: Career-site submissions
summary: Durable private intake and Google Sheet projection for Jarrett Crosby's career-site forms.
status: active
kind: module-contract
area: integrations
tags: [career-site, forms, postgres, google-sheets, outbox, privacy]
app_visible: true
---

# Career-site submissions

## Purpose

Record accepted contact, résumé-request, and explicit vlog-newsletter submissions from Jarrett Crosby's career site before projecting them into a private Google Sheet. This integration is a bounded personal workflow. It does not turn a visitor into a ClawPilot user, CRM lead, sales opportunity, or marketing subscriber beyond the consent they explicitly supplied.

## Authority and authentication

- Railway Postgres is the durable authority for accepted submissions and delivery state.
- The Google Sheet is a private operator-facing projection. It is not a second intake API or an application database.
- `POST /api/career-site/submissions` is server-to-server only. It reuses the existing authenticated short-link service identity and accepts only the `jarrett-career-site` source, the configured owner email, and that owner's active ClawPilot workspace membership.
- The caller supplies the same backend-only bearer secret, `x-shortlink-source`, and `x-shortlink-owner` headers used by the short-link client. Browser code must never receive the secret.
- Every request requires a caller-generated UUID `submissionId`. Exact replays return the existing record; reuse with different normalized data fails with `409`.
- `CAREER_SITE_SUBMISSIONS_ENABLED` defaults off. Enabling it requires the exact owner email, private Sheet ID, a matching short-link client, and the expected tab/header location.

## Accepted forms

- `contact` stores name, email, optional organization, inquiry category, message, and an optional first-party source URL.
- `resume-request` stores name, email, optional organization, optional context, the requested résumé family (`executive`, `servicenow`, or `odyssey`), the two separate networking and role-fit checkboxes, and an optional first-party source URL. This family is distinct from the ATS versus Coffee Between Chapters edition Jarrett chooses during private approval.
- `newsletter` stores only email, explicit newsletter consent, and an optional first-party source URL. Contact and résumé requests never imply newsletter consent.

The source URL must use `https://jarrett.suburbiasandwichco.com`; query parameters and fragments are removed before persistence. The intake rejects unknown fields and never accepts or stores Turnstile tokens, honeypot values, request IPs, cookies, approval tokens, résumé access grants, short-link URLs, or Google credentials. Original application documents and derived branded career documents remain outside this intake and are not changed by form capture.

## Server caller contract

The production ingress is `POST https://aiapp.eigenracing.com/api/career-site/submissions`. Each of the career site's three server routes calls it only after its own body limits, rate limit, honeypot, timing, schema, and Turnstile checks pass. Required headers are:

```http
Authorization: Bearer <jarrett-career-site service secret>
Content-Type: application/json
x-shortlink-source: jarrett-career-site
x-shortlink-owner: jarrett@suburbiasandwichco.com
x-shortlink-organization: <optional exact ClawPilot organization UUID>
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

The résumé route maps its local `context` field to `message` and local `variant` to `resumeVariant`. `resumeVariant` is exactly `executive`, `servicenow`, or `odyssey`. `networkInterest` and `roleFit` are explicit booleans. It must not send `newsletterConsent`.

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

## Durable delivery

Migration `0328_career_site_submissions.sql` creates:

- `career_site_submissions`, scoped by the authenticated ClawPilot owner and workspace membership;
- `career_site_submission_outbox`, with one delivery item per submission, leased with `FOR UPDATE SKIP LOCKED`, bounded retries, and dead-letter state.

The application commits the submission and outbox row in one Postgres transaction before returning `201`. The Railway poller calls `POST /api/career-site/submissions/outbox/process` with `PIPELINE_OUTBOX_WORKER_SECRET`. The worker uses ClawPilot's existing encrypted Google Workspace credential through `resolveGoogleWorkspaceProvisioningRuntime`; the career site does not need a Google service-account JSON.

The worker verifies the configured spreadsheet, exact tab, and header row; creates the header only when that row is empty; and refuses a mismatched contract. It checks the immutable submission ID column in the bounded data range before append, then writes with Sheets `valueInputOption=RAW`. This prevents visitor text beginning with `=`, `+`, `-`, or `@` from becoming a formula and lets an ambiguous append response deduplicate safely on retry. If the verified 50,000-row deduplication range fills, synchronization stops safely instead of risking a duplicate append.

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

`Shortlink Status` is lifecycle text only. Do not add approval tokens, résumé URLs, ClawPilot short links, or access-grant data to this Sheet. Keep sharing limited to Jarrett and the configured ClawPilot service account. If the Sheet lives in Jarrett's My Drive, Jarrett remains its owner and grants that service account editor access. If it lives in the selected Shared Drive, preserve the Shared Drive's restricted membership and do not create `anyone`, domain, or public permissions.

## Runtime configuration

Set these Railway variables before enabling intake:

- `CAREER_SITE_SUBMISSIONS_ENABLED=1`
- `CAREER_SITE_SUBMISSIONS_OWNER_EMAIL=jarrett@suburbiasandwichco.com`
- `CAREER_SITE_SUBMISSIONS_SHEET_ID=<private spreadsheet ID>`
- `CAREER_SITE_SUBMISSIONS_SHEET_TAB=Submissions`
- `CAREER_SITE_SUBMISSIONS_SHEET_HEADER_ROW=4`
- optional `CAREER_SITE_SUBMISSIONS_POLL_MS=10000`

The existing `SHORTLINK_SERVICE_CLIENTS_JSON` must contain `jarrett-career-site`, and the Google Workspace integration in **Settings > Integrations > Google Workspace** must report a verified API key, service account, and selected writable Shared Drive. Do not copy the stored service-account JSON into Vercel or source control.

## Operational checks

1. Keep the feature disabled while the migration and private Sheet are prepared.
2. Verify the Google Workspace integration and share the Sheet with the displayed service-account email.
3. Enable the five runtime values above and deploy through the normal `dev` to `main` release path.
4. Submit one contact test with a unique UUID and confirm Postgres returns `201` without returning PII.
5. Confirm the outbox worker appends one row, then replay the same UUID and verify no second row appears.
6. Verify `/api/health` and `/api/persistence/status` remain healthy and inspect only counts/statuses when diagnosing failures; do not log form bodies.
