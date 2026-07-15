---
title: Application Shell and Access
status: active
kind: module-contract
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
- New users receive a branded welcome link first. That invitation must be valid before an invitation-purpose sign-in code can activate the account.
- The configured owner can invite users, assign global application roles, and grant explicit privileges. Application administration is independent from organization membership, so a child-organization user may also be a global application administrator.
- An invitation must assign the person to an existing organization or deliberately create a child organization. It must never synthesize a personal organization from the person's name or email.
- Organization membership and hierarchy placement define the user's data graph. The global `owner`, `admin`, or `member` role plus explicit permissions controls application administration.
- Each user manages name, job title, organization, timezone, locale, integrations, and sharing in Settings. Profile changes update that user's CRM Contact and organization membership projection.
- Timestamps are stored in UTC and rendered in the signed-in user's timezone and locale.
- ChatGPT/Codex authorization is stored per ClawPilot user. One user's credential cannot authorize another user's agent execution.

## Durable Data

- `app_users`
- `app_user_invitations`
- `auth_magic_codes`
- `app_users.organization_id`, organization hierarchy, global role, and explicit permissions
- separate encrypted agent credential database

## Confirmed Nick Access

- Nick remains assigned to the organization named exactly `Nick's Organization`; that display name is canonical.
- Nick retains the global application role `admin`; that access assignment is intentional.
- Global application role and organization data scope are independent. Nick's global admin role permits authorized software-administration functions, while CRM, pipeline, board, document, and short-link data access still resolves through organization relationships and explicit sharing.

## Security Boundary

An invited account is not a normal active account. Ordinary sign-in rejects invited, disabled, expired, or revoked access. Invitation activation consumes the code and invitation in one database transaction. Settings and administration endpoints enforce both the global privilege and organization boundary instead of trusting client-selected organization IDs.
