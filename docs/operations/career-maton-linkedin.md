---
id: cp-ops-career-maton-linkedin
title: Career Desk Maton LinkedIn source
summary: Read-only LinkedIn paid-job discovery, email notification boundaries, and capability verification.
status: active
kind: operations-runbook
area: integrations
tags: [career, linkedin, maton, gmail]
app_visible: false
---

# Career Desk Maton LinkedIn source

The existing user-owned Maton credential and selected ACTIVE `linkedin`
connection provide a read-only Job Library adapter. The private Career Desk
service identity calls `GET` or `POST /api/career-site/sources/linkedin/jobs`.
It does not use or change the legacy browser worker or extension.

GET verifies the selected connection's profile capability. The response states
`jobsSupported: true`, `inboxSupported: false`, and that jobs have not yet been
probed. It never equates a profile check with successful job import.

POST accepts only `query` (plain job-search text, up to 180 characters; default
`supply chain`) and `maxJobs` (1–10, default 10). It returns `source`, `coverage`,
`availability`, `jobs`, `scannedCount`, `filteredCount`, and a `warning` string.
Candidates contain `externalJobId`, canonical `sourceUrl`, archive `evidenceUrl`,
`title`, `company`, `location`, `description`, `postedAt`, `observedAt`, and
`availability: unverified`. No salary or fit claim is synthesized here.

The provider's keyword search includes job body text, not just title. The adapter
therefore additionally requires a senior operations-related title, explicit US
country evidence, a posting within 45 days, unrestricted data, and no known
closed status. It caps each run at eight pages of three provider records, ten returned
candidates, 4 MiB per response, and a 50-second execution deadline. Every request
is a fixed, owner-bound GET. Retry attempts share an eight-request total budget.
Provider pagination URLs are not followed. A 429 or
5xx response receives at most one bounded retry; authorization/version errors
are returned explicitly with sanitized messages.

Job Library covers paid job posts and retains closed jobs. Its archive is not
proof that a vacancy is open. The consumer must keep these as unverified leads,
check the live vacancy and the $180k / relocation-over-$200k salary policy, and
apply its normal evidence-backed fit analysis before qualified matching.

## Capability evidence (2026-09-04)

Read-only production probes of the owner's existing ACTIVE Maton connection
returned 200 for `/linkedin/rest/me` and `/linkedin/rest/jobLibrary`. Job Library
returned US jobs including Alaska, Virginia, and California. The checked-in
version `202605` worked; Maton's older `202506` example returned 426 (retired
version). Some archive calls returned transient 500 responses. No external
LinkedIn writes were attempted.

The Maton connection is not a personal LinkedIn inbox connector. General
messaging access requires LinkedIn partner permissions; do not advertise a full
inbox sync or route undocumented private-browser endpoints through this adapter.
Gmail notification imports, where supported, remain explicitly email records.

The Gmail filter admits an actual LinkedIn message notification only when it
comes from the LinkedIn sender domain, has a message/InMail subject, includes a
LinkedIn messaging URL, and contains specific role plus recruitment/interview
text. Social/unsubscribe wrappers do not alone make such messages spam. Job
alerts, social engagement notices, generic "you have a message" emails without
message content, unsafe links, nonemployment offers, spam, and trash still fail
closed. This cannot import messages that LinkedIn did not email to the user.

Sent-thread correlation remains same-thread evidence, not a complete outbox
index: the importer reads SENT labels only for otherwise eligible inbound
candidates, including terse replies with an explicit interview/phone-screen
subject that omit the role from that individual message. Such a reply requires
verified same-thread SENT evidence and still obeys the spam/nonemployment vetoes.
Cross-thread company/requisition correlation and keyword-free
follow-ups to an active interview require a separate persisted conversation
identity/index and are not claimed by this adapter.

Sources: [Maton LinkedIn](https://docs.maton.ai/linkedin),
[Maton gateway](https://docs.maton.ai/gateway),
[LinkedIn Job Library](https://www.linkedin.com/help/linkedin/answer/a7449391),
[LinkedIn Messages API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/messages).

Run `node scripts/test-career-site-linkedin-jobs.mjs` for the focused gate.
