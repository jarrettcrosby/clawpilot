---
id: cp-module-shell-access
title: Application Shell and Access
summary: Authentication, invitations, user profiles, roles, permissions, dashboard workspace defaults, navigation, activity history, and responsive shell behavior.
status: active
kind: module-contract
area: access
tags: [shell, authentication, invitations, users, dashboard, workspaces]
app_visible: true
---

# Application Shell and Access

## Purpose

Provide a responsive, authenticated ClawPilot workspace with clear user identity, role controls, and private per-user credentials.

## Current Contract

- Dashboard, Docs, Projects, Pipeline, CRM, Accounting, POS, Links, Agents, and Versions are authenticated workspace surfaces. Dashboard links open the corresponding record or module rather than acting as static summaries.
- The dashboard board and pipeline selectors are independent per-user defaults. Selecting either resource persists it for the signed-in user, refreshes only the scoped dashboard data, and does not reload the full application.
- Dashboard project-board status counts request the selected board explicitly and include CRM-projected cards. Operational task and agent metrics continue to exclude CRM reference cards.
- The pipeline selector loads the selected pipeline explicitly and presents its opportunity, organization, contact, and open-value summary alongside the selected project board.
- Initial dashboard loading uses a stable Skeleton shell that reserves the final layout while workspace preferences, board tasks, and pipeline summary data resolve.
- Desktop navigation is a sibling layout track and can collapse without covering or shifting page content incorrectly.
- Mobile navigation uses a temporary drawer plus compact bottom navigation; secondary modules remain reachable through More in portrait and landscape layouts.
- Text action controls size against their actual dialog, card, or panel container rather than the outer viewport. Multi-action rows wrap before controls shrink, visible button labels remain readable instead of collapsing word by word, and dialog action groups wrap without clipping at supported desktop, tablet, portrait, and landscape widths.
- Existing active users sign in with a six-digit one-time code.
- Google sign-in is additive to magic codes and disabled per organization by default. An owner or administrator with `manageUserAccess` may enable it for the active organization only after the platform-owned Google Web OAuth client is configured. Each signed-in user then explicitly links their own Google account from web Settings > Security or the iPhone Session Security card; the verified Google email must exactly match that existing ClawPilot user email. One user's Google link never authorizes another user. ClawPilot persists the durable Google subject-to-user link, never the ID token. A later Google login resolves that subject link and an active membership in an organization whose Google policy is still enabled. A Google-authenticated browser may switch only into another active membership whose organization has also enabled Google sign-in; this prevents one organization from authorizing Google access to another organization that left it disabled. Creating a new root business requires magic-code authentication because the new organization's Google policy begins disabled. Google authentication never creates a user, accepts an invitation, creates a membership, changes a role, or links a different email. Disabling an organization's policy prevents new Google sessions or Google-authenticated switches into that organization without disabling magic codes, deleting the durable link, or retroactively revoking an already active session.
- `GOOGLE_SSO_SERVER_CLIENT_ID` is one platform-level OAuth 2.0 **Web application** client ID, not an organization secret. ClawPilot intentionally returns that same public ID to Google Identity Services in the browser and verifies browser and native ID tokens against it as the server audience. The Google Cloud client must list every browser origin where linking is offered, including `https://dev.aiapp.eigenracing.com` and `https://aiapp.eigenracing.com`; any local or preview origin used for linking must be added explicitly as its own authorized JavaScript origin.
- Every successful sign-in creates an independently revocable Postgres browser session. The cookie contains only a random opaque secret; Postgres stores its HMAC hash, authenticated and effective identities, device summary, validated sign-in and last-observed IP addresses reported by the hosting edge, activity timestamps, idle and absolute expiry, revocation state, and bounded support-mode state.
- Every browser session selects exactly one active workspace organization. A user with more than one active membership can switch businesses from the application header; the server validates the target membership, rotates the session token, audits the change, clears stale board and pipeline selections, and refreshes only tenant-scoped content with that workspace's defaults. The application shell remains mounted so switching does not incur a full document reload. Separate browsers may remain in separate active workspaces for the same user.
- Opening the business menu performs a read-only dashboard prefetch for at most two recently used alternative workspaces. Prefetched data stays only in that browser tab's memory for 45 seconds, is authorized against the user's active membership, creates no resources or documents, changes no session or selection cookie, and emits no workspace-switch audit event. An explicit business selection may hydrate the dashboard from that snapshot immediately, then revalidates through the normal active-workspace APIs.
- Owner and administrator sessions expire after one hour without verified user activity; member sessions expire after eight hours without activity. All sessions have a 24-hour absolute limit. Background polling does not extend inactivity by itself.
- Settings > Security lists the signed-in user's active browsers with their authenticated identity, effective identity during support mode, sign-in address, and last-observed address. The user can revoke one browser or every other browser. Disabling an account or changing its access revokes that user's active browser sessions.
- New users receive a branded welcome link first. That invitation must be valid before an invitation-purpose sign-in code can activate the account.
- Invitations start with the Member role. The invitation form explains that organization selection controls data scope, the owner may promote the resulting user to Admin and select administrative permissions, and CRM employee status is only for people who may own CRM records.
- The configured owner can invite users, assign global application roles, and grant explicit privileges. Application administration is independent from organization membership, so a child-organization user may also be a global application administrator.
- The root owner can edit every non-owner account in the managed organization graph. Administrators with `manageUserAccess` can edit members but cannot promote users, edit another administrator, modify the owner, or grant privileges outside their own effective access.
- Owner permissions are fixed. Member permissions are limited to work creation; administrative switches become available only after the owner promotes the person to Admin. Settings explains these constraints beside the disabled controls.
- An invitation must assign the person to an existing organization or deliberately create a child organization. It must never synthesize a personal organization from the person's name or email.
- Organization membership and hierarchy placement define the user's data graph. The global `owner`, `admin`, or `member` role plus explicit permissions controls application administration.
- Each user manages name, job title, organization, timezone, locale, integrations, and sharing in Settings. Profile changes update that user's CRM Contact and organization membership projection.
- Settings > Integrations exposes **Sales channels** to the owner and users with **Manage operations** permission. That panel manages organization-scoped Shopify/Faire commerce credentials and capability evidence without exposing Google, QuickBooks, Toast, user-access administration, or plaintext provider secrets. Commerce remains separate from the restaurant POS surface.
- Timestamps are stored in UTC and rendered in the signed-in user's timezone and locale.
- ChatGPT/Codex authorization is stored per ClawPilot user. One user's credential cannot authorize another user's agent execution.
- Activity is independent from the selected board or pipeline. Every user can review events they performed and security events targeting their account.
- CRM Activity entries expose the affected record type and Global ID when available. Separate events for an Account, Contact, Opportunity, Meeting, or Interaction must remain distinct and must not be deleted merely because their human-readable summaries are similar.
- Opening an activity target first resolves and selects the event's owning board or pipeline, including CRM pipeline records, and then opens the referenced task, document, Global ID, or module. The target action must never depend on whichever project or pipeline happened to be selected before the Activity drawer opened.
- Administrators with `viewOrganizationAudit` can review the immutable event-time history for their assigned organization subtree. Moving a user or changing a share does not retroactively reclassify an event.
- Administrators with `viewSystemAudit` can review global platform and worker activity. That scope excludes tenant board, pipeline, CRM, document, and short-link records.
- Successful and failed sign-ins, code requests, and sign-outs are audited without copying raw IP addresses into the general activity stream and without storing magic codes, cookies, credentials, or provider tokens. Raw addresses remain confined to the access-controlled browser-session record.
- The configured root owner may enter a 30-minute user view after recent authentication. Authorization uses the selected effective user, while audit rows retain the root owner as the authenticated actor plus the effective user and session ID. A persistent banner identifies support mode; account access, integrations, and security mutations remain blocked until the root owner exits user view.
- CRM queue activity is recorded only when a new idempotent SuiteCRM outbox item is inserted. Re-reading an unchanged CRM screen does not produce another audit row, and historical no-op rows are removed by matching them against actual outbox creation evidence.

## Durable Data

- `app_users`
- `app_user_invitations`
- `auth_magic_codes`
- `app_sessions`
  - authenticated and effective user identities, active workspace organization, and validated `inet` sign-in and last-observed addresses
- `app_user_organization_memberships`, keyed by user email and organization with membership role, permissions, status, and default preference
- `app_organization_auth_policies`, keyed by organization with a default-off Google sign-in flag and optimistic row version
- `app_user_external_identities`, containing the immutable verified Google subject-to-existing-user link and the organization where that explicit link was authorized
- `app_auth_mutation_receipts`, deduplicating version-fenced Google policy and identity-link commands without storing OAuth tokens or provider subjects in command results
- `app_user_workspace_preferences`, keyed by user email and workspace organization with nullable foreign keys to that workspace's default project board and pipeline
- `app_documents.workspace_organization_id`, required on every generated, repository, user, and agent document so a person with multiple businesses cannot read documents from another active workspace
- `app_users.organization_id`, retained only as a compatibility/default pointer; request authorization resolves from the browser session's active organization membership
- organization hierarchy, global application role, and explicit global permissions
- `audit_events.subject`, `audit_events.organization_id`, `audit_events.is_system`, and idempotent event keys
- separate encrypted agent credential database

## Confirmed Nick Access

- Nick remains assigned to the organization named exactly `Nick's Organization`; that display name is canonical.
- Express Parcel International DBA EPISCS is a peer root workspace for the configured owner. Creating it grants no EPISCS membership to Olivia, Nick, or any other existing or invited Suburbia user and moves no board, pipeline, CRM, document, short-link, or integration data.
- Existing and ordinary invited users remain in the Suburbia Sandwich Co tree unless an administrator explicitly selects another organization during invitation. Switching the inviter's browser does not silently reparent an existing user.
- Nick retains the global application role `admin`; that access assignment is intentional.
- Nick's account and organization membership remain `disabled`. Disabled status and administrator privileges are independent: the privileges are preserved for a future explicit restore, but they do not permit sign-in or access while disabled. Access reconciliation must never reactivate him and must revoke any existing browser sessions.
- Global application role and organization data scope are independent. Nick's global admin role permits authorized software-administration functions, while CRM, pipeline, board, document, and short-link data access still resolves through organization relationships and explicit sharing.

## Security Boundary

An invited account is not a normal active account. Ordinary sign-in rejects invited, disabled, expired, or revoked access. Invitation activation consumes the code and invitation in one database transaction and activates the exact invited organization membership. Google cannot bypass that lifecycle: identity linking requires a recent, non-impersonated session, a matching verified email, a current enabled organization policy row version, and a stable idempotency key; Google login requires the stored provider subject plus an enabled active membership and never falls back to email-only authorization. Settings and administration endpoints enforce both the global privilege and active membership boundary instead of trusting client-selected organization IDs. Dashboard defaults are saved only after access to the selected board or pipeline is resolved within the active workspace. Background agent workers use a separate bearer-secret channel with validated operator, organization, and board claims; they never create or reuse browser sessions.
