---
id: cp-module-short-links
title: Shared Short Links
summary: Organization-scoped short-link ownership, slugs, limits, lifecycle, search, and cross-application use.
status: active
kind: module-contract
area: links
tags: [links, redirects, eigenracing, tenancy]
app_visible: true
---

# Shared Short Links

## Purpose

Provide one durable, user-scoped link service for ClawPilot and trusted applications while publishing compact URLs under `eigenracing.com` or, for eligible BPO workspace users, `bposupplychain.com`.

## Ownership And Access

- Every link has an owner email and source application.
- A signed-in ClawPilot user can discover links only inside their exact workspace organization. Parent, child, sibling, and unrelated organizations do not inherit one another's user-created link inventory.
- Members may mutate only links they created. Owners and administrators with `manageLinks` may support and govern links owned by users in that same organization.
- Trusted applications call the server-side API with a source-bound service credential and the authenticated user's email. A service client can list or mutate only links matching both that user and its bound source. Credentials never enter browser bundles.
- Slugs remain globally unique across both domains. Existing rows keep their legacy Eigen URL; the BPO domain is selected and stored when a new link is created, then cannot be changed.
- The BPO choice appears only for a signed-in user in an exact server-configured BPO workspace after the BPO public route has been verified and explicitly enabled. Service clients retain the legacy domain by default. Caller-supplied hosts are never accepted.
- Organization owners/admins set the new-link domain default in Settings > Profile > Organization web addresses. The initial preference is BPO, falling back to Eigen until BPO is enabled. They can allow or lock user overrides. Users inherit the organization preference unless an allowed explicit per-user/workspace preference is saved; choosing Organization default restores inheritance. Locked policy overrides preserved user preferences and forbids conflicting per-link choices on the server, not only in the UI. Restoring permission re-enables those preserved preferences. This does not rewrite existing links or change trusted service-client domain behavior.

## Link Controls

- Operators may choose a 3-64 character slug or generate a 4-32 character slug.
- A link can have tags, a title, an expiration time, and a maximum click count.
- Search covers the destination, generated URL or slug, title, and tags.
- CRM `ga`, `gc`, `gl`, `go`, `gm`, `gi`, and `gk` references use their code as the stable slug. After authentication, ClawPilot resolves the record only through a pipeline the user is authorized to access.
- Redirect resolution locks the row before enforcing limits and incrementing usage, so concurrent final clicks cannot exceed the cap.
- Public redirects are no-store and no-referrer. Destination URLs always require HTTPS, including links created from development environments.

## Cross-Application Contract

- ClawPilot owns the durable Postgres records and `/api/shortlinks` management API.
- `https://eigenracing.com/s/{slug}` is the canonical public form.
- Eligible new links may instead use `https://bposupplychain.com/s/{slug}`. The BPO website keeps its existing apex site and adds only a server-side `/s/{slug}` route. That route calls ClawPilot's exact `/api/shortlinks/bpo/resolve/{slug}` endpoint with a server-only bearer secret and `redirect: manual`, then returns the result. ClawPilot resolves only rows stored for the BPO domain before counting a click; a link from another workspace or the Eigen domain cannot be laundered through the BPO route.
- The BPO resolver returns `307 Location` on success, `404` for unknown or wrong-domain slugs, `410` for disabled/expired/exhausted links, `401` for invalid bearer, and `405` to HEAD without counting a click. Responses are no-store, no-referrer, and noindex. The BPO site mirrors these statuses and never exposes the bearer token to a browser.
- Eigen Racing proxies authenticated management requests with `sourceApp=eigenracing` and resolves public slugs through the ClawPilot service.
- Click events intentionally retain only the source application and referrer host; raw IP addresses and browser fingerprints are not stored.
