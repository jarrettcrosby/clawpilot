---
id: cp-decision-0002
title: Organization-Rooted Tenancy
summary: Users belong to organizations; organization subtrees scope data while application roles separately grant administrative capability.
status: active
kind: decision-record
area: tenancy
date: 2026-07-15
decision_status: accepted
tags: [clawpilot, decision, tenancy, organizations, permissions]
app_visible: true
---

# 0002 - Organization-Rooted Tenancy

## Context

ClawPilot must support users in the root company, users in child companies, shared resources, and trusted administrators who may manage the application without changing the company that owns their data.

## Decision

Every tenant-owned operation belongs to one workspace organization. Parent-child organization relationships define the visible CRM and resource subtree. Application roles and explicit permissions are independent from organization membership. Invitations require the target organization; they never create an organization implicitly.

[Decision 0005](0005-multi-workspace-membership.md) amends the original one-user/one-organization assumption: one app identity may hold multiple memberships, while each request and browser session remains scoped to exactly one active workspace organization.

## Consequences

- A child-organization user can hold global administrator permissions while remaining scoped to that organization for ordinary tenant data.
- Boards, pipelines, CRM boards, documents, and short links enforce owner, membership, and organization boundaries.
- A user profile projects to a CRM Contact under the related workspace Account.
- Moving a user between organizations is an explicit audited administrator action.

## Connected Notes

- [Application Shell and Access](../modules/application-shell-and-access.md)
- [Projects and Tenancy](../modules/projects-and-tenancy.md)
- [Shared Short Links](../modules/short-links.md)
- [CRM and Workbook Reporting](../modules/crm-and-reporting.md)
