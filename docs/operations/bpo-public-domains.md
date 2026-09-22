---
id: cp-ops-bpo-public-domains
title: BPO Public Domains
summary: Additive BPO app login hosts and organization-scoped short links while preserving Eigen domains and suspended development.
status: active
kind: operations-runbook
area: access
tags: [domains, bpo, shortlinks, authentication, railway]
app_visible: false
---

# BPO public domains

This is an additive configuration, not an account or organization migration.
Existing Eigen URLs, identity keys, memberships, credentials, and stored links
remain unchanged. See [Shared Short Links](../modules/short-links.md) and
[Application Shell and Access](../modules/application-shell-and-access.md).

## Host routing

| Host | Target | Purpose |
| --- | --- | --- |
| `bposupplychain.com` | Existing BPO Vercel website | Preserve the company homepage; add only `/s/{slug}` for BPO links. |
| `aiapp.bposupplychain.com` | Production Railway ClawPilot | Additional login host for the same production app. |
| `aiapp.eigenracing.com` | Existing production Railway ClawPilot | Existing login host and canonical provider callback origin. |
| `dev.aiapp.bposupplychain.com` | Development Railway ClawPilot | Additional development login host, available only after an intentional restart. |
| `dev.aiapp.eigenracing.com` | Existing development Railway ClawPilot | Existing development host; still suspended. |

On September 21, 2026, the two BPO app hosts were registered on their respective
existing Railway services without changing deployment state. The required DNS
records under `bposupplychain.com` were:

| Type | Name | Value |
| --- | --- | --- |
| CNAME | `aiapp` | `igeagpk5.up.railway.app` |
| CNAME | `dev.aiapp` | `w1fd4g1z.up.railway.app` |

At registration, `aiapp` still pointed at the BPO Vercel gateway, which redirects
to the Eigen app, and `dev.aiapp` had no record. Both CNAME records above were
subsequently saved and verified against the authoritative DNS server on
September 21. The corresponding Railway ownership TXT records were then added
under `_railway-verify.aiapp` and `_railway-verify.dev.aiapp`; both hosts reached
verified ownership and valid certificates. A TLS-validated request to the
production Railway target returned the login page with HTTP 200 and no Eigen
redirect. A subsequent normal public request also returned Railway HTTP 200
without an Eigen redirect after the recursive cache expired. A real magic-code
sign-in then loaded the existing production account and dashboard on the BPO
hostname, without redirecting to Eigen. That baseline check used release
`40c12a4`; repeat it after the new identity/domain release. Recheck these targets in
Railway before later changes.
Do not change apex, `www`, MX, SPF, DKIM, or unrelated DNS records.

## App configuration

- Preserve each environment's existing `CLAWPILOT_PUBLIC_URL` and account keys.
- Production may set `CLAWPILOT_ADDITIONAL_PUBLIC_ORIGINS_JSON` to
  `["https://aiapp.bposupplychain.com"]` after its hostname is verified.
- Development may use `["https://dev.aiapp.bposupplychain.com"]`; never put a
  production hostname in the development allowlist or vice versa.
- Cookies remain host-only, Secure in hosted runtimes, and separate between
  domains. A user signs in on each host; this does not create a new user.
- Google browser sign-in requires adding the exact new HTTPS origin to the
  existing Google Web OAuth client's authorized JavaScript origins. A working
  magic-code login does not prove Google sign-in acceptance.
- Provider OAuth callbacks, webhooks, and general authentication links retain
  their current canonical URLs. Explicit organization invitations may use the
  enabled app address chosen by that organization's administrator. Do not alter
  provider redirect registrations or copy sessions between domains merely to
  support an additional login host.

## BPO short-link rollout

1. Deploy the additive nullable `short_links.public_domain` migration and tested
   app changes through the normal release gates. Existing rows stay null and
   keep their Eigen URLs and global slug identity.
2. Add the BPO website's server route `/s/{slug}`. It calls only
   `https://aiapp.eigenracing.com/api/shortlinks/bpo/resolve/{slug}` with a
   dedicated `SHORTLINK_BPO_RESOLVER_SECRET` shared between those two production
   services. Keep the secret out of Git, browsers, and public runtime variables.
3. The resolver verifies the stored BPO domain before counting a click. The
   website does not follow the upstream redirect, forward session cookies, or
   expose provider error bodies. Both new endpoints reject HEAD without
   consuming a click.
4. Configure exact permitted workspace UUIDs in
   `SHORTLINK_BPO_ALLOWED_ORGANIZATION_IDS_JSON`. Initially scope to BPO Supply
   Chain Services unless the operator explicitly chooses broader availability.
5. Verify the website route, resolver authentication/domain isolation, limits,
   expiration, privacy headers, and an approved disposable test link before
   setting `SHORTLINK_BPO_PUBLIC_ROUTE_READY=1`. Until then the BPO creation
   option remains disabled. Do not enable production BPO link generation in
   development: the public apex resolver reads production only.
6. Verify the domain choice remains attached to a link across save and reload,
   while existing Eigen links continue to resolve. A domain choice is immutable
   after creation; create a new link for a different branded URL.

Use a source-only staging directory for BPO website deployments. The local BPO
workspace also holds private client deliverables; never upload that whole folder
without checking deployment exclusions and exact source scope.

## Local validation and remaining activation

On September 21, 2026, local validation passed for:

- ClawPilot production build and full lint.
- BPO website production build, type check, and server-bridge tests.
- Exact browser-origin and public resolver-path tests (12 cases).
- Short-link domain, legacy-domain preservation, bearer authentication, and
  no-click HEAD tests.
- A guarded disposable PostgreSQL test for same-email cross-workspace list,
  update, and delete rejection, with same-workspace positive controls. The
  disposable database was removed after the test.
- PostgreSQL adapter contracts and the documentation catalog.

These are validation results, not a production acceptance claim. The BPO website
source-only protected preview also passed route and fail-closed checks. The
shared production resolver credential, exact BPO workspace allowlist, and
additional production app origin were staged without deploying or changing the
active application. Public DNS and TLS were verified. The new application
release, website promotion, Google browser origin, and signed-in UI acceptance
still require activation/verification. BPO link creation stays off until its
public route is verified. A read-only production
check found zero non-deleted links with `organization_root_id IS NULL` on that
date. Recheck before a later release; do not guess an organization assignment or
weaken the workspace fence to accommodate any newly discovered legacy rows.

## Acceptance and recovery

Verify exact deployment commit, health and persistence, DNS/TLS on both
production login hosts, magic-code sign-in to the same account, organization
scope, and the Google origin separately. Keep evidence outside Git when it
contains account IDs or provider records. Follow
[Development on Demand](development-on-demand.md) without waking dev just to
register or verify its retained hostname configuration.

If the new app host fails, leave the existing Eigen host available. Restore only
the exact prior `aiapp` CNAME if a DNS rollback is needed. Disable new BPO link
creation by clearing its readiness flag; preserve already-created link records
and the resolver so published links do not break. Never delete data as a domain
rollback.
