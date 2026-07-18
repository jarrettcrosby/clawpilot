---
id: cp-decision-0005
title: Multi-Workspace User Membership
summary: One ClawPilot identity may belong to multiple independent root businesses while every request remains scoped to one active workspace.
status: active
kind: decision-record
area: tenancy
date: 2026-07-18
decision_status: accepted
tags: [clawpilot, decision, tenancy, organizations, sessions, isolation]
app_visible: true
---

# 0005 - Multi-Workspace User Membership

## Context

A person may own or operate more than one independent business. Suburbia Sandwich Co and Express Parcel International DBA EPISCS are peer businesses with different customers, CRM graphs, pipelines, workbooks, products, boards, integrations, and reporting. Nesting one under the other would grant incorrect visibility and contaminate business-specific reporting.

## Decision

One app identity may hold memberships in multiple workspace organizations. Independent businesses are separate root workspace organizations. Every authenticated browser session selects exactly one active workspace organization, and every tenant-owned read, write, job, credential, audit event, and agent context resolves through that active membership.

Global application role, organization membership role, and resource sharing remain separate controls. A user may own two organizations, administer the ClawPilot application globally, and still operate within only one tenant boundary per request.

## Data Contract

- Add an organization-membership table keyed by user email and workspace organization with organization role, permissions, status, and default preference.
- Add an active workspace organization to each browser session. Switching workspaces validates an active membership and writes an audit event containing authenticated user, effective user, session, previous workspace, and next workspace.
- Keep `app_users.organization_id` as a compatibility/default pointer during migration, then remove it from authorization decisions after every module reads the active membership.
- Backfill every existing invited or active user's current organization as their first membership. No CRM, pipeline, board, document, Sheet, short-link, integration, or audit record moves during the backfill.
- Impersonation may select only a workspace available to the effective user. The authenticated operator, effective user, and active workspace remain visible in audit history.

## Isolation Contract

Each root workspace owns an independent primary CRM pipeline, CRM Account graph, personal and shared pipelines, managed Google Drive hierarchy and workbooks, project boards, CRM boards, Docs, short links, product catalog, agents and organization memory, provider credentials, Toast locations and sales, accounting mappings, and export drafts.

Personal authentication such as the user's ChatGPT connection remains attached to the person, but agent retrieval and execution context is partitioned by active workspace. Organization integrations such as Toast never reuse credentials across memberships.

## Interface Contract

- Show the active business in the application shell and provide a workspace switcher when the user has more than one active membership.
- Switching reloads the selected workspace's default board and pipeline and clears stale resource parameters from the URL.
- Creation dialogs, settings, reports, notifications, and activity state the active business when ambiguity could cause a cross-company action.
- A new independent business onboarding flow creates a new root and membership. Inviting an employee adds membership to an existing root or descendant; it does not create a synthetic organization.

## Delivery Order

1. Membership and per-session active-workspace schema with compatibility backfill.
2. Request-user resolution, switch API, audit, impersonation constraints, and authorization tests.
3. Shell switcher plus default board/pipeline hydration.
4. Module-by-module removal of direct `app_users.organization_id` authorization assumptions.
5. Create EPISCS as a peer root, add Jarrett's owner membership, and provision its isolated resources.

## Connected Notes

- [Organization-Rooted Tenancy](0002-organization-rooted-tenancy.md)
- [Application Shell and Access](../modules/application-shell-and-access.md)
- [Projects and Tenancy](../modules/projects-and-tenancy.md)
- [Toast Sales and Accounting](../modules/toast-and-accounting.md)
- [Platform and Data Map](../maps/platform-data-map.md)
