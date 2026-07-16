---
id: cp-module-shell-access
title: Application Shell and Access
summary: Authentication, invitations, user profiles, roles, permissions, navigation, activity history, and responsive shell behavior.
status: active
kind: module-contract
area: access
tags: [shell, authentication, invitations, users]
app_visible: true
---

# Application Shell and Access

## Purpose

Provide a responsive, authenticated ClawPilot workspace with clear user identity, role controls, and private per-user credentials.

## Current Contract

- Dashboard, Docs, Projects, Pipeline, CRM, Links, Agents, and Versions are authenticated workspace surfaces. Dashboard links open the corresponding record or module rather than acting as static summaries.
- Desktop navigation is a sibling layout track and can collapse without covering or shifting page content incorrectly.
- Mobile navigation uses a temporary drawer plus compact bottom navigation; secondary modules remain reachable through More in portrait and landscape layouts.
- Existing active users sign in with a six-digit one-time code.
- Every successful sign-in creates an independently revocable Postgres browser session. The cookie contains only a random opaque secret; Postgres stores its HMAC hash, authenticated and effective identities, device summary, activity timestamps, idle and absolute expiry, revocation state, and bounded support-mode state.
- Owner and administrator sessions expire after one hour without verified user activity; member sessions expire after eight hours without activity. All sessions have a 24-hour absolute limit. Background polling does not extend inactivity by itself.
- Settings > Security lists the signed-in user's active browsers and supports revoking one browser or every other browser. Disabling an account or changing its access revokes that user's active browser sessions.
- New users receive a branded welcome link first. That invitation must be valid before an invitation-purpose sign-in code can activate the account.
- The configured owner can invite users, assign global application roles, and grant explicit privileges. Application administration is independent from organization membership, so a child-organization user may also be a global application administrator.
- An invitation must assign the person to an existing organization or deliberately create a child organization. It must never synthesize a personal organization from the person's name or email.
- Organization membership and hierarchy placement define the user's data graph. The global `owner`, `admin`, or `member` role plus explicit permissions controls application administration.
- Each user manages name, job title, organization, timezone, locale, integrations, and sharing in Settings. Profile changes update that user's CRM Contact and organization membership projection.
- Timestamps are stored in UTC and rendered in the signed-in user's timezone and locale.
- ChatGPT/Codex authorization is stored per ClawPilot user. One user's credential cannot authorize another user's agent execution.
- Activity is independent from the selected board or pipeline. Every user can review events they performed and security events targeting their account.
- Administrators with `viewOrganizationAudit` can review the immutable event-time history for their assigned organization subtree. Moving a user or changing a share does not retroactively reclassify an event.
- Administrators with `viewSystemAudit` can review global platform and worker activity. That scope excludes tenant board, pipeline, CRM, document, and short-link records.
- Successful and failed sign-ins, code requests, and sign-outs are audited without storing magic codes, raw IP addresses, cookies, credentials, or provider tokens.
- The configured root owner may enter a 30-minute user view after recent authentication. Authorization uses the selected effective user, while audit rows retain the root owner as the authenticated actor plus the effective user and session ID. A persistent banner identifies support mode; account access, integrations, and security mutations remain blocked until the root owner exits user view.
- CRM queue activity is recorded only when a new idempotent SuiteCRM outbox item is inserted. Re-reading an unchanged CRM screen does not produce another audit row, and historical no-op rows are removed by matching them against actual outbox creation evidence.

## Durable Data

- `app_users`
- `app_user_invitations`
- `auth_magic_codes`
- `app_sessions`
- `app_users.organization_id`, organization hierarchy, global role, and explicit permissions
- `audit_events.subject`, `audit_events.organization_id`, `audit_events.is_system`, and idempotent event keys
- separate encrypted agent credential database

## Confirmed Nick Access

- Nick remains assigned to the organization named exactly `Nick's Organization`; that display name is canonical.
- Nick retains the global application role `admin`; that access assignment is intentional.
- Global application role and organization data scope are independent. Nick's global admin role permits authorized software-administration functions, while CRM, pipeline, board, document, and short-link data access still resolves through organization relationships and explicit sharing.

## Security Boundary

An invited account is not a normal active account. Ordinary sign-in rejects invited, disabled, expired, or revoked access. Invitation activation consumes the code and invitation in one database transaction. Settings and administration endpoints enforce both the global privilege and organization boundary instead of trusting client-selected organization IDs. Background agent workers use a separate bearer-secret channel with validated operator and board claims; they never create or reuse browser sessions.
