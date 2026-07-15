---
title: Shared Short Links
status: active
kind: module-contract
tags: [links, redirects, eigenracing, tenancy]
app_visible: true
---

# Shared Short Links

## Purpose

Provide one durable, user-scoped link service for ClawPilot and trusted Eigen Racing applications while publishing compact URLs under `eigenracing.com`.

## Ownership And Access

- Every link has an owner email and source application.
- A signed-in ClawPilot user can discover links only inside their workspace-organization tree. This permits the root organization and its invited member organizations to share links without exposing them to unrelated tenants.
- Members may mutate only links they created. Owners and administrators with `manageLinks` may support and govern every link in their organization tree.
- Trusted applications call the server-side API with a source-bound service credential and the authenticated user's email. A service client can list or mutate only links matching both that user and its bound source. Credentials never enter browser bundles.
- Slugs are globally unique because every application publishes through the same public domain.

## Link Controls

- Operators may choose a 3-64 character slug or generate a 4-32 character slug.
- A link can have tags, a title, an expiration time, and a maximum click count.
- Search covers the destination, generated URL or slug, title, and tags.
- CRM `ga`, `gc`, `gl`, `go`, `gm`, `gi`, and `gk` references use their code as the stable slug and open the matching ClawPilot CRM record.
- Redirect resolution locks the row before enforcing limits and incrementing usage, so concurrent final clicks cannot exceed the cap.
- Public redirects are no-store and no-referrer. Destination URLs always require HTTPS, including links created from development environments.

## Cross-Application Contract

- ClawPilot owns the durable Postgres records and `/api/shortlinks` management API.
- `https://eigenracing.com/s/{slug}` is the canonical public form.
- Eigen Racing proxies authenticated management requests with `sourceApp=eigenracing` and resolves public slugs through the ClawPilot service.
- Click events intentionally retain only the source application and referrer host; raw IP addresses and browser fingerprints are not stored.
