---
id: cp-map-evolution
title: Evolution Map
summary: How to reconstruct why ClawPilot changed, what shipped, and which historical evidence remains authoritative.
status: active
kind: map-of-content
area: evolution
tags: [clawpilot, moc, decisions, releases, history, evidence]
app_visible: true
---

# Evolution Map

## Why The Platform Looks This Way

Read the [Decision Index](../decisions/index.md) for accepted product and architecture tradeoffs:

- [Postgres and Sheets Authority](../decisions/0001-postgres-and-sheets-authority.md)
- [Organization-Rooted Tenancy](../decisions/0002-organization-rooted-tenancy.md)
- [CRM Global Identity and Synchronization](../decisions/0003-crm-global-identity-and-sync.md)
- [Local-First Knowledge Retrieval](../decisions/0004-local-first-knowledge-retrieval.md)
- [Native Distributed Operations Authority and Adapter Boundaries](../decisions/0006-native-distributed-operations-authority.md)

## Distributed Operations Design Trail

- The [integration and gap map](distributed-operations-integration-gap-map.md) records current reusable services and unresolved platform/domain gaps.
- The [domain contract](../modules/distributed-operations.md) defines target state machines, events, security, concurrency, and optimization boundaries.
- The [delivery plan](../architecture/distributed-operations-delivery-plan.md) maps phased migration and acceptance through stable scenarios S01-S25.
- The [runbook](../operations/distributed-operations-runbook.md) remains draft until activation, health, reconciliation, and on-call controls exist.

## What Shipped

- The [Release Documentation Contract](../releases/README.md) defines the required release record.
- The in-app Versions surface is the complete environment-specific user history.
- The release catalog provides deployment copy when an environment first records a commit.
- GitHub pull requests and Git commits provide implementation diffs and review evidence.

## Historical Evidence

- The [stable-build integrity incident](../incidents/2026-03-20-stable-build-integrity-outage.md) remains because it explains a current release control.
- Superseded plans and worklogs are consolidated into active contracts, then retained only in Git history.
- Compatibility-pointer notes exist only where a script or build still depends on an old path; they do not define current behavior.

## Change Discipline

Every implementation changes four layers when applicable: code, focused verification, the owning active contract, and release copy. A new decision record is added only when the choice changes a durable boundary or would otherwise be repeatedly rediscovered.
