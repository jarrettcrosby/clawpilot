---
id: cp-decision-index
title: Decision Index
summary: Accepted ClawPilot decisions and the contracts that implement them.
status: active
kind: map-of-content
area: decisions
tags: [clawpilot, moc, decisions, architecture]
app_visible: true
---

# Decision Index

Decision records explain durable choices and tradeoffs. Current behavior still lives in the linked module or operations contract.

| Decision | Status | Primary contracts |
| --- | --- | --- |
| [0001 - Postgres and Sheets Authority](0001-postgres-and-sheets-authority.md) | Accepted | Pipeline, CRM, knowledge |
| [0002 - Organization-Rooted Tenancy](0002-organization-rooted-tenancy.md) | Accepted | Access, projects, short links |
| [0003 - CRM Global Identity and Synchronization](0003-crm-global-identity-and-sync.md) | Accepted | CRM, SuiteCRM, pipeline |
| [0004 - Local-First Knowledge Retrieval](0004-local-first-knowledge-retrieval.md) | Accepted | Knowledge and integrations |
| [0005 - Multi-Workspace User Membership](0005-multi-workspace-membership.md) | Accepted | Access, sessions, all tenant modules |

## When To Add A Decision

Add a decision record when a choice changes data authority, tenancy, security, identity, integration ownership, release safety, or a cross-module contract. Do not add one for routine implementation detail that is obvious from the code and pull request.

Use the [decision template](../templates/decision-record.md), link the resulting record here, and update the connected active contract in the same change.
